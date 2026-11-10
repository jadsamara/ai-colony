/**
 * Single-agent Math baseline. One model call per item.
 * This path does not start a colony conversation and does not read or write memory.
 */
import type { InferenceProvider, InferenceResult } from "../inference/provider.js";
import type { TokenSource } from "../inference/usage.js";
import { withinTolerance, type ToleranceSpec } from "../verification/tolerance.js";
import {
  configurationFingerprint,
  contentDigest,
  disabledConfig,
  EVALUATION_CONTRACT_VERSION,
  omittedConfig,
  parseEvaluationManifest,
  setConfig,
  unknownConfig,
  type EvaluationManifest,
} from "./manifest.js";
import { wilsonInterval, type Interval } from "./stats.js";
import {
  C18A_EXPERIMENT_ID,
  evaluationItems,
  fewShotExamples,
  formatQuantity,
  solveMathItem,
  workedSolution,
  type FrozenMathSuite,
  type MathDifficulty,
  type MathFamilyId,
  type MathParameters,
  type MathSkillId,
  type MathSuiteItem,
} from "./math-suite.js";
import {
  compareSpecializations,
  summarizeSpecializations,
  type SpecializationComparison,
  type SpecializationSummary,
} from "./math-specialization.js";

export const MATH_PROMPT_VERSIONS = {
  standard: "c18a-standard-v1",
  fewShotThinking: "c18a-few-shot-thinking-v1",
  toolAssisted: "c18a-tool-assisted-v1",
  calculator: "c18a-calculator-bound-v1",
} as const;

export const MATH_SCORER_VERSION = "c18a-numeric-v1" as const;
export const MATH_ANSWER_EXTRACTOR_VERSION = "c18a-final-or-number-v1" as const;
export const MATH_HARNESS_VERSION = "c18a-single-agent-v1" as const;

export const MATH_BASELINE_DECODING = {
  temperature: 0,
  timeoutMs: 120_000,
  standard: { maxOutputTokens: 256, reasoningEffort: "none" },
  fewShotThinking: { maxOutputTokens: 1024, reasoningEffort: "unset" },
  toolAssisted: { maxOutputTokens: 256, reasoningEffort: "none" },
} as const;

const STANDARD_SYSTEM =
  "Solve this math problem by yourself. Do not consult other agents or departments. Reply with the numeric result only.";
const FEW_SHOT_SYSTEM =
  "Solve this math problem by yourself. Do not consult other agents or departments. Study the worked examples, think step by step, and end with a line FINAL: <number>.";
const TOOL_SYSTEM =
  "Solve this math problem by yourself. Do not consult other agents or departments. You may request the bound-parameter calculator by replying with exactly CALCULATOR <family> and no numbers. Families: affine, kinetic_energy, ohm_power, tsiolkovsky_propellant. The calculator uses the problem's registered parameters and ignores any numbers you add. If you compute it yourself, reply with exactly FINAL: <number>.";

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_ONLY = new RegExp(`^${NUMBER}$`);
const FINAL_LINE = new RegExp(`^FINAL:\\s*(${NUMBER})\\s*$`, "i");
const EXACT_TOOL = /^CALCULATOR\s+(affine|kinetic_energy|ohm_power|tsiolkovsky_propellant)\s*$/i;

export type MathConditionId =
  "standard" | "few_shot_thinking" | "tool_assisted" | "calculator_bound_parameters";

export type MathToolOutcome =
  "none" | "accepted" | "rejected_family" | "rejected_parameter_override";

export interface MathGrade {
  parsed: number | null;
  taskCorrect: boolean;
  ambiguous: boolean;
  tool: MathToolOutcome;
}

export interface MathItemResult {
  itemId: string;
  family: MathFamilyId;
  departmentId: string;
  skillId: MathSkillId;
  equationFamily: MathFamilyId;
  difficulty: MathDifficulty;
  generatorVersion: string;
  templateId: string;
  expected: number;
  units: string;
  raw: string;
  parsed: number | null;
  taskCorrect: boolean;
  ambiguous: boolean;
  tool: MathToolOutcome;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenSource: TokenSource | "not_applicable";
  servedModel: string | null;
  servedDigest: string | null;
}

export interface MathConditionReport {
  conditionId: MathConditionId;
  promptVersion: string;
  promptDigest: string;
  systemPromptDigest: string;
  decoding: {
    temperature: number;
    maxOutputTokens: number | null;
    topP: "omitted";
    seed: "omitted";
    reasoningEffort: "none" | "unset" | "not_applicable";
    thinking: "enabled" | "disabled";
  };
  modelCall: boolean;
  accuracy: number;
  correct: number;
  sampleSize: number;
  wilson95: Interval;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  gate: "not_applied";
  manifest: EvaluationManifest;
  specialization: SpecializationSummary;
  items: MathItemResult[];
}

export interface MathBaselineModel {
  family: string;
  alias: string;
  registryModelId: string;
  weightsVersion: "base";
  adapterId: null;
  installedDigest: string | null;
  backendId: string;
  backendVersion: string | null;
}

export interface MathBaselineReport {
  experimentId: string;
  department: "math";
  phase: "C1.8A";
  status: "completed";
  trained: false;
  databaseWrites: false;
  activeDepartmentModelsChanged: false;
  colonyComparison: "not_run";
  memory: { retrieval: "closed_book"; forgettingCycle: "not_run" };
  suite: {
    generatorVersion: string;
    contentHash: string;
    itemSetFingerprint: string;
    evaluationCount: number;
    trainingCount: number;
    tolerance: ToleranceSpec;
    claimExtractor: "not_used";
  };
  model: MathBaselineModel;
  conditions: MathConditionReport[];
}

export interface MathBaselineInput {
  suite: FrozenMathSuite;
  model: MathBaselineModel;
  providers: {
    standard: InferenceProvider;
    fewShotThinking: InferenceProvider;
    toolAssisted: InferenceProvider;
  };
  experimentId?: string;
  gitCommit?: string | null;
  recordedAt?: string;
  environment?: string;
}

export function renderStandardUser(item: MathSuiteItem): string {
  return item.prompt;
}

export function renderFewShotUser(suite: FrozenMathSuite, item: MathSuiteItem): string {
  if (item.split !== "evaluation") {
    throw new Error("few-shot evaluation only renders evaluation items");
  }
  const examples = fewShotExamples(suite);
  if (examples.some((example) => example.id === item.id || example.split !== "train")) {
    throw new Error("few-shot examples must be training items distinct from the evaluation item");
  }
  const blocks = examples.map(
    (example, index) =>
      `Example ${index + 1}:\n${example.prompt}\n${workedSolution(example)}\nFINAL: ${formatQuantity(example.expected)}`,
  );
  return `${blocks.join("\n\n")}\n\nProblem:\n${item.prompt}\nThink step by step, then end with FINAL: <number>.`;
}

export function renderToolUser(item: MathSuiteItem): string {
  return item.prompt;
}

export function gradeMathResponse(input: {
  expected: number;
  raw: string;
  mode: "number_only" | "final_line" | "tool_or_final";
  parameters: MathParameters;
  tolerance: ToleranceSpec;
}): MathGrade {
  if (input.mode === "tool_or_final") {
    const tool = parseTool(input.raw);
    if (tool.kind === "contaminated") {
      return {
        parsed: null,
        taskCorrect: false,
        ambiguous: false,
        tool: "rejected_parameter_override",
      };
    }
    if (tool.kind === "family") {
      if (tool.family !== input.parameters.family) {
        return { parsed: null, taskCorrect: false, ambiguous: false, tool: "rejected_family" };
      }
      const solved = solveMathItem(input.parameters);
      const check = withinTolerance(solved.value, input.expected, input.tolerance);
      return { parsed: solved.value, taskCorrect: check.ok, ambiguous: false, tool: "accepted" };
    }
    const graded = gradeFinal(input.raw, input.expected, input.tolerance);
    return { ...graded, tool: "none" };
  }
  if (input.mode === "number_only") {
    const parsed = parseNumberOnly(input.raw);
    return finishNumeric(parsed, input.expected, input.tolerance);
  }
  const graded = gradeFinal(input.raw, input.expected, input.tolerance);
  return { ...graded, tool: "none" };
}

export function scoreCalculatorCeiling(suite: FrozenMathSuite): MathItemResult[] {
  return evaluationItems(suite).map((item) => {
    const solved = solveMathItem(item.parameters);
    const grade = gradeMathResponse({
      expected: item.expected,
      raw: formatQuantity(solved.value),
      mode: "number_only",
      parameters: item.parameters,
      tolerance: suite.tolerance,
    });
    return itemResult(item, formatQuantity(solved.value), grade, emptyInference());
  });
}

export async function runMathBaseline(input: MathBaselineInput): Promise<MathBaselineReport> {
  const experimentId = input.experimentId ?? C18A_EXPERIMENT_ID;
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const environment = input.environment ?? "single-agent";
  const heldOut = evaluationItems(input.suite);
  const standard = await runModelCondition({
    conditionId: "standard",
    suite: input.suite,
    items: heldOut,
    provider: input.providers.standard,
    model: input.model,
    experimentId,
    recordedAt,
    environment,
    gitCommit: input.gitCommit ?? null,
    promptVersion: MATH_PROMPT_VERSIONS.standard,
    system: STANDARD_SYSTEM,
    userFor: renderStandardUser,
    mode: "number_only",
    maxOutputTokens: MATH_BASELINE_DECODING.standard.maxOutputTokens,
    reasoningEffort: "none",
    thinking: "disabled",
    tools: "unavailable",
  });
  const fewShot = await runModelCondition({
    conditionId: "few_shot_thinking",
    suite: input.suite,
    items: heldOut,
    provider: input.providers.fewShotThinking,
    model: input.model,
    experimentId,
    recordedAt,
    environment,
    gitCommit: input.gitCommit ?? null,
    promptVersion: MATH_PROMPT_VERSIONS.fewShotThinking,
    system: FEW_SHOT_SYSTEM,
    userFor: (item) => renderFewShotUser(input.suite, item),
    mode: "final_line",
    maxOutputTokens: MATH_BASELINE_DECODING.fewShotThinking.maxOutputTokens,
    reasoningEffort: "unset",
    thinking: "enabled",
    tools: "unavailable",
  });
  const toolAssisted = await runModelCondition({
    conditionId: "tool_assisted",
    suite: input.suite,
    items: heldOut,
    provider: input.providers.toolAssisted,
    model: input.model,
    experimentId,
    recordedAt,
    environment,
    gitCommit: input.gitCommit ?? null,
    promptVersion: MATH_PROMPT_VERSIONS.toolAssisted,
    system: TOOL_SYSTEM,
    userFor: renderToolUser,
    mode: "tool_or_final",
    maxOutputTokens: MATH_BASELINE_DECODING.toolAssisted.maxOutputTokens,
    reasoningEffort: "none",
    thinking: "disabled",
    tools: "available",
  });
  const calculatorItems = scoreCalculatorCeiling(input.suite);
  const calculator = summarizeCondition({
    conditionId: "calculator_bound_parameters",
    suite: input.suite,
    model: input.model,
    experimentId,
    recordedAt,
    environment,
    gitCommit: input.gitCommit ?? null,
    promptVersion: MATH_PROMPT_VERSIONS.calculator,
    system: "bound-parameter calculator; no model prompt",
    maxOutputTokens: null,
    reasoningEffort: "not_applicable",
    thinking: "disabled",
    tools: "available",
    modelCall: false,
    items: calculatorItems,
  });
  return {
    experimentId,
    department: "math",
    phase: "C1.8A",
    status: "completed",
    trained: false,
    databaseWrites: false,
    activeDepartmentModelsChanged: false,
    colonyComparison: "not_run",
    memory: { retrieval: "closed_book", forgettingCycle: "not_run" },
    suite: {
      generatorVersion: input.suite.generatorVersion,
      contentHash: input.suite.contentHash,
      itemSetFingerprint: input.suite.itemSetFingerprint,
      evaluationCount: heldOut.length,
      trainingCount: input.suite.items.length - heldOut.length,
      tolerance: input.suite.tolerance,
      claimExtractor: "not_used",
    },
    model: input.model,
    conditions: [standard, fewShot, toolAssisted, calculator],
  };
}

async function runModelCondition(input: {
  conditionId: Exclude<MathConditionId, "calculator_bound_parameters">;
  suite: FrozenMathSuite;
  items: MathSuiteItem[];
  provider: InferenceProvider;
  model: MathBaselineModel;
  experimentId: string;
  recordedAt: string;
  environment: string;
  gitCommit: string | null;
  promptVersion: string;
  system: string;
  userFor: (item: MathSuiteItem) => string;
  mode: "number_only" | "final_line" | "tool_or_final";
  maxOutputTokens: number;
  reasoningEffort: "none" | "unset";
  thinking: "enabled" | "disabled";
  tools: "available" | "unavailable";
}): Promise<MathConditionReport> {
  const results: MathItemResult[] = [];
  for (const item of input.items) {
    const user = input.userFor(item);
    const response = await input.provider.generate({
      requestId: `${input.experimentId}:${input.conditionId}:${item.id}`,
      registryModelId: input.model.registryModelId,
      modelAlias: input.model.alias,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: user },
      ],
      temperature: MATH_BASELINE_DECODING.temperature,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs: MATH_BASELINE_DECODING.timeoutMs,
      jsonObject: false,
    });
    const grade = gradeMathResponse({
      expected: item.expected,
      raw: response.text,
      mode: input.mode,
      parameters: item.parameters,
      tolerance: input.suite.tolerance,
    });
    results.push(itemResult(item, response.text, grade, response));
  }
  return summarizeCondition({ ...input, modelCall: true, items: results });
}

function summarizeCondition(input: {
  conditionId: MathConditionId;
  suite: FrozenMathSuite;
  model: MathBaselineModel;
  experimentId: string;
  recordedAt: string;
  environment: string;
  gitCommit: string | null;
  promptVersion: string;
  system: string;
  maxOutputTokens: number | null;
  reasoningEffort: "none" | "unset" | "not_applicable";
  thinking: "enabled" | "disabled";
  tools: "available" | "unavailable";
  modelCall: boolean;
  items: MathItemResult[];
}): MathConditionReport {
  const correct = input.items.filter((item) => item.taskCorrect).length;
  const sampleSize = input.items.length;
  const promptDigest = contentDigest(`${input.promptVersion}\n${input.system}`);
  const manifest = buildManifest({
    conditionId: input.conditionId,
    suite: input.suite,
    model: input.model,
    recordedAt: input.recordedAt,
    environment: input.environment,
    gitCommit: input.gitCommit,
    promptVersion: input.promptVersion,
    promptDigest,
    system: input.system,
    maxOutputTokens: input.maxOutputTokens,
    thinking: input.thinking,
    tools: input.tools,
    runId: `${input.experimentId}:${input.conditionId}`,
    items: input.items,
  });
  return {
    conditionId: input.conditionId,
    promptVersion: input.promptVersion,
    promptDigest,
    systemPromptDigest: contentDigest(input.system),
    decoding: {
      temperature: MATH_BASELINE_DECODING.temperature,
      maxOutputTokens: input.maxOutputTokens,
      topP: "omitted",
      seed: "omitted",
      reasoningEffort: input.reasoningEffort,
      thinking: input.thinking,
    },
    modelCall: input.modelCall,
    accuracy: sampleSize === 0 ? 0 : correct / sampleSize,
    correct,
    sampleSize,
    wilson95: wilsonInterval(correct, sampleSize),
    inputTokens: sumTokens(input.items.map((item) => item.inputTokens)),
    outputTokens: sumTokens(input.items.map((item) => item.outputTokens)),
    latencyMs: input.items.reduce((total, item) => total + item.latencyMs, 0),
    gate: "not_applied",
    manifest,
    specialization: summarizeSpecializations(input.items),
    items: input.items,
  };
}

export function compareMathBaselineSpecializations(
  baseline: MathBaselineReport,
  candidate: MathBaselineReport,
  conditionId: MathConditionId,
): SpecializationComparison {
  const left = baseline.conditions.find((condition) => condition.conditionId === conditionId);
  const right = candidate.conditions.find((condition) => condition.conditionId === conditionId);
  if (!left || !right) {
    throw new Error(`condition ${conditionId} is missing from a math baseline report`);
  }
  return compareSpecializations(
    {
      conditionId,
      contentHash: baseline.suite.contentHash,
      generatorVersion: baseline.suite.generatorVersion,
      itemSetFingerprint: baseline.suite.itemSetFingerprint,
      manifest: left.manifest,
      items: left.items,
    },
    {
      conditionId,
      contentHash: candidate.suite.contentHash,
      generatorVersion: candidate.suite.generatorVersion,
      itemSetFingerprint: candidate.suite.itemSetFingerprint,
      manifest: right.manifest,
      items: right.items,
    },
  );
}

function buildManifest(input: {
  conditionId: MathConditionId;
  suite: FrozenMathSuite;
  model: MathBaselineModel;
  recordedAt: string;
  environment: string;
  gitCommit: string | null;
  promptVersion: string;
  promptDigest: string;
  system: string;
  maxOutputTokens: number | null;
  thinking: "enabled" | "disabled";
  tools: "available" | "unavailable";
  runId: string;
  items: MathItemResult[];
}): EvaluationManifest {
  const digest = hexDigest(input.model.installedDigest);
  return parseEvaluationManifest({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    model: {
      family: setConfig(input.model.family),
      identifier: setConfig(input.model.registryModelId),
      alias: setConfig(input.model.alias),
      checkpointId: setConfig(`${input.model.alias}:base`),
      checkpointDigest: digest ? setConfig(digest) : unknownConfig(),
      adapterId: disabledConfig(),
      adapterVersion: disabledConfig(),
      adapterDigest: disabledConfig(),
      quantization: unknownConfig(),
    },
    backend: {
      id: setConfig(input.model.backendId),
      version: input.model.backendVersion ? setConfig(input.model.backendVersion) : unknownConfig(),
    },
    evaluation: {
      scope: setConfig("math_department_baseline"),
      benchmarkId: setConfig(input.suite.experimentId),
      benchmarkVersion: setConfig(input.suite.generatorVersion),
      itemSetFingerprint: setConfig(input.suite.itemSetFingerprint),
      itemCount: setConfig(input.items.length),
      promptTemplateId: setConfig(input.promptVersion),
      promptTemplateDigest: setConfig(input.promptDigest),
      systemPromptId: setConfig(input.promptVersion),
      systemPromptDigest: setConfig(contentDigest(input.system)),
      scorerId: setConfig("math-numeric"),
      scorerVersion: setConfig(MATH_SCORER_VERSION),
      extractorId: setConfig("math-answer"),
      extractorVersion: setConfig(MATH_ANSWER_EXTRACTOR_VERSION),
      harnessVersion: setConfig(MATH_HARNESS_VERSION),
    },
    generation: {
      maxOutputTokens:
        input.maxOutputTokens === null ? disabledConfig() : setConfig(input.maxOutputTokens),
      temperature: setConfig(MATH_BASELINE_DECODING.temperature),
      topP: omittedConfig(),
      seed: omittedConfig(),
      thinking: setConfig(input.thinking),
      stopSequences: omittedConfig(),
      contextWindow: unknownConfig(),
      tools: setConfig(input.tools),
      retrieval: setConfig("closed_book" as const),
    },
    execution: {
      runId: setConfig(input.runId),
      recordedAt: setConfig(input.recordedAt),
      environment: setConfig(input.environment),
      gitCommit: input.gitCommit ? setConfig(input.gitCommit) : unknownConfig(),
      status: setConfig("completed" as const),
      provenance: omittedConfig(),
    },
  });
}

export function configurationFingerprintFor(report: MathConditionReport): string {
  return configurationFingerprint(report.manifest);
}

function itemResult(
  item: MathSuiteItem,
  raw: string,
  grade: MathGrade,
  response: InferenceResult | null,
): MathItemResult {
  return {
    itemId: item.id,
    family: item.family,
    departmentId: item.specialization.departmentId,
    skillId: item.specialization.skillId,
    equationFamily: item.specialization.equationFamily,
    difficulty: item.specialization.difficulty,
    generatorVersion: item.specialization.generatorVersion,
    templateId: item.templateId,
    expected: item.expected,
    units: item.units,
    raw,
    parsed: grade.parsed,
    taskCorrect: grade.taskCorrect,
    ambiguous: grade.ambiguous,
    tool: grade.tool,
    latencyMs: response?.latencyMs ?? 0,
    inputTokens: response?.usage.inputTokens ?? null,
    outputTokens: response?.usage.outputTokens ?? null,
    tokenSource: response?.usage.source ?? "not_applicable",
    servedModel: response?.servedModel ?? null,
    servedDigest: response?.servedDigest ?? null,
  };
}

function emptyInference(): InferenceResult | null {
  return null;
}

function gradeFinal(
  raw: string,
  expected: number,
  tolerance: ToleranceSpec,
): Omit<MathGrade, "tool"> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const finals = lines.filter((line) => /^FINAL:/i.test(line));
  if (finals.length > 1) {
    return { parsed: null, taskCorrect: false, ambiguous: true };
  }
  if (finals.length === 1) {
    const line = finals[0] ?? "";
    const match = FINAL_LINE.exec(line);
    const token = match?.[1];
    if (!token) {
      return { parsed: null, taskCorrect: false, ambiguous: true };
    }
    return finishNumeric({ value: Number(token), ambiguous: false }, expected, tolerance);
  }
  if (lines.length === 0) {
    return { parsed: null, taskCorrect: false, ambiguous: false };
  }
  return { parsed: null, taskCorrect: false, ambiguous: true };
}

function parseNumberOnly(raw: string): { value: number | null; ambiguous: boolean } {
  const text = raw.trim();
  if (!NUMBER_ONLY.test(text)) {
    return { value: null, ambiguous: text.length > 0 };
  }
  return { value: Number(text), ambiguous: false };
}

function finishNumeric(
  parsed: { value: number | null; ambiguous: boolean },
  expected: number,
  tolerance: ToleranceSpec,
): MathGrade {
  if (parsed.value === null || !Number.isFinite(parsed.value)) {
    return { parsed: null, taskCorrect: false, ambiguous: parsed.ambiguous, tool: "none" };
  }
  const check = withinTolerance(parsed.value, expected, tolerance);
  return { parsed: parsed.value, taskCorrect: check.ok, ambiguous: false, tool: "none" };
}

function parseTool(
  raw: string,
): { kind: "family"; family: MathFamilyId } | { kind: "contaminated" } | { kind: "absent" } {
  const text = raw.trim();
  const exact = EXACT_TOOL.exec(text);
  const family = exact?.[1]?.toLowerCase();
  if (
    family === "affine" ||
    family === "kinetic_energy" ||
    family === "ohm_power" ||
    family === "tsiolkovsky_propellant"
  ) {
    return { kind: "family", family };
  }
  if (/^CALCULATOR\b/i.test(text)) {
    return { kind: "contaminated" };
  }
  return { kind: "absent" };
}

function hexDigest(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const stripped = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[a-f0-9]{64}$/i.test(stripped) ? stripped.toLowerCase() : null;
}

function sumTokens(values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) {
    return null;
  }
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
