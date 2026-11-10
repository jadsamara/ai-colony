import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  assignMathDifficulty,
  assignMathSkill,
  buildMathSuite,
  compareMathBaselineSpecializations,
  evaluationItems,
  extractNumericalClaims,
  fewShotExamples,
  gradeMathResponse,
  MATH_DEPARTMENT_ID,
  renderFewShotUser,
  runMathBaseline,
  scoreCalculatorCeiling,
  solveMathItem,
  tsiolkovskyPropellantMass,
  verifyFrozenMathSuite,
  type InferenceResult,
  type MathBaselineModel,
  type MathBaselineReport,
} from "@ai-colony/core";
import { ScriptedInferenceProvider } from "@ai-colony/inference";

const FROZEN_PATH = "packages/core/src/evaluation/fixtures/c18a-math-suite-v1.json";

describe("C1.8A math evaluation suite", () => {
  it("freezes a reproducible suite whose hash matches the committed file", () => {
    const built = buildMathSuite();
    const again = buildMathSuite();
    const frozen = verifyFrozenMathSuite(JSON.parse(readFileSync(FROZEN_PATH, "utf8")));
    expect(again.contentHash).toBe(built.contentHash);
    expect(frozen.contentHash).toBe(built.contentHash);
    expect(frozen.itemSetFingerprint).toBe(built.itemSetFingerprint);
    expect(frozen.generatorVersion).toBe("c18a-math-v1");
    expect(frozen.contentHash).toBe(
      "18f5d06093f838158f97c1ad06fafbbed84e4dfcde64a6bba8e6612475869225",
    );
    expect(frozen.departmentId).toBe(MATH_DEPARTMENT_ID);
    expect(frozen.claimExtractor).toBe("not_used");
    expect(frozen.items).toHaveLength(32);
    expect(evaluationItems(frozen)).toHaveLength(16);
  });

  it("keeps training and evaluation templates, prompts, and parameters apart", () => {
    const suite = buildMathSuite();
    const trainTemplates = new Set(suite.templateIds.train);
    const evaluationTemplates = new Set(suite.templateIds.evaluation);
    expect([...evaluationTemplates].some((templateId) => trainTemplates.has(templateId))).toBe(
      false,
    );
    expect(new Set(suite.items.map((item) => item.family)).size).toBe(4);
    const trainPrompts = new Set(
      suite.items.filter((item) => item.split === "train").map((item) => item.prompt),
    );
    for (const item of evaluationItems(suite)) {
      expect(trainTemplates.has(item.templateId)).toBe(false);
      expect(trainPrompts.has(item.prompt)).toBe(false);
    }
    const examples = fewShotExamples(suite);
    expect(examples.every((item) => item.split === "train")).toBe(true);
    const rendered = renderFewShotUser(suite, evaluationItems(suite)[0]!);
    for (const item of evaluationItems(suite).slice(1)) {
      expect(rendered.includes(item.prompt)).toBe(false);
    }
  });

  it("computes ground truth from bound parameters, not from displayed unit text", () => {
    const suite = buildMathSuite();
    const grams = evaluationItems(suite).find(
      (item) =>
        item.templateId === "kinetic.eval.grams" &&
        item.parameters.family === "kinetic_energy" &&
        item.parameters.massKg === 0.4,
    );
    expect(grams).toBeDefined();
    if (!grams || grams.parameters.family !== "kinetic_energy") {
      throw new Error("missing gram-display kinetic item");
    }
    expect(grams.prompt).toContain("400 g");
    expect(grams.expected).toBe(solveMathItem(grams.parameters).value);
    expect(grams.expected).toBe(20);
    expect(grams.expected).not.toBeCloseTo(0.5 * 400 * 100);

    const rocket = evaluationItems(suite).find(
      (item) =>
        item.templateId === "tsiolkovsky.eval.kms" &&
        item.parameters.family === "tsiolkovsky_propellant" &&
        item.parameters.deltaV_m_s === 4000,
    );
    expect(rocket).toBeDefined();
    if (!rocket || rocket.parameters.family !== "tsiolkovsky_propellant") {
      throw new Error("missing kilometer-display rocket item");
    }
    expect(rocket.prompt).toContain("4 km/s");
    expect(rocket.prompt).toContain("4000 m/s");
    const misread = tsiolkovskyPropellantMass({ ...rocket.parameters, deltaV_m_s: 4 });
    expect(rocket.expected).toBe(tsiolkovskyPropellantMass(rocket.parameters).propellantMassKg);
    expect(Math.abs(rocket.expected - misread.propellantMassKg)).toBeGreaterThan(100);
  });

  it("does not let the C1.7.4 parameter attribution path set evaluation ground truth", () => {
    const suite = buildMathSuite();
    const ion = evaluationItems(suite).find(
      (item) =>
        item.parameters.family === "tsiolkovsky_propellant" && item.parameters.isp_s === 3000,
    );
    expect(ion).toBeDefined();
    if (!ion || ion.parameters.family !== "tsiolkovsky_propellant") {
      throw new Error("missing ion evaluation item");
    }
    const chemical = tsiolkovskyPropellantMass({
      dryMassKg: 1000,
      deltaV_m_s: 3000,
      isp_s: 350,
    }).propellantMassKg;
    const ionMass = tsiolkovskyPropellantMass({
      dryMassKg: 1000,
      deltaV_m_s: 3000,
      isp_s: 3000,
    }).propellantMassKg;
    expect(ion.expected).toBe(ionMass);
    expect(Math.abs(ion.expected - chemical)).toBeGreaterThan(1000);

    const extracted = extractNumericalClaims({
      turnId: "c18a-attribution-guard",
      body: "Propellant mass is 107 kg.",
      contextBodies: ["dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s, ion Isp 3000 s"],
    });
    const request = extracted.find(
      (candidate) => candidate.verificationRequest?.kind === "tsiolkovsky_propellant_mass",
    );
    expect(request?.verificationRequest?.kind).toBe("tsiolkovsky_propellant_mass");
    if (request?.verificationRequest?.kind !== "tsiolkovsky_propellant_mass") {
      throw new Error("expected the known attribution path to bind a propellant claim");
    }
    expect(request.verificationRequest.input.isp_s).toBe(350);
    expect(request.verificationRequest.input.isp_s).not.toBe(ion.parameters.isp_s);
    expect(ion.expected).toBe(solveMathItem(ion.parameters).value);
  });
});

describe("C1.8A specialization tracking", () => {
  it("assigns department, skill, family, difficulty, template, and generator on every item", () => {
    const suite = buildMathSuite();
    const skills = new Set<string>();
    for (const item of suite.items) {
      expect(item.specialization.departmentId).toBe(MATH_DEPARTMENT_ID);
      expect(item.specialization.skillId).toBe(assignMathSkill(item.templateId));
      expect(item.specialization.equationFamily).toBe(item.family);
      expect(item.specialization.difficulty).toBe(assignMathDifficulty(item.parameters));
      expect(item.specialization.templateId).toBe(item.templateId);
      expect(item.specialization.generatorVersion).toBe("c18a-math-v1");
      skills.add(item.specialization.skillId);
    }
    expect([...skills].sort()).toEqual([
      "algebra",
      "numerical_reasoning",
      "physics_equations",
      "unit_conversion",
    ]);
    const line = evaluationItems(suite).find((item) => item.templateId === "affine.eval.line");
    const grams = evaluationItems(suite).find((item) => item.templateId === "kinetic.eval.grams");
    expect(line?.specialization.skillId).toBe("algebra");
    expect(line?.specialization.difficulty).toBe("easy");
    expect(grams?.specialization.skillId).toBe("unit_conversion");
  });

  it("reports per-skill accuracy and a regression only on a previously strong skill", async () => {
    const suite = buildMathSuite();
    const base = await runScored(suite, () => true);
    const regressed = await runScored(
      suite,
      (item) => item.specialization.skillId !== "unit_conversion",
    );
    const standard = base.conditions.find((condition) => condition.conditionId === "standard");
    expect(standard?.specialization.departmentAccuracy).toBe(1);
    expect(standard?.specialization.adapterBinding).toBe("none");
    const unit = standard?.specialization.bySkill.find(
      (skill) => skill.skillId === "unit_conversion",
    );
    const physics = standard?.specialization.byFamily.find(
      (family) => family.equationFamily === "kinetic_energy",
    );
    expect(unit?.sampleSize).toBe(6);
    expect(unit?.accuracy).toBe(1);
    expect(physics?.sampleSize).toBe(4);
    const comparison = compareMathBaselineSpecializations(base, regressed, "standard");
    expect(comparison.comparable).toBe(true);
    expect(comparison.benchmark.contentHash).toBe(suite.contentHash);
    expect(comparison.adapterPerSkill).toBe(false);
    expect(comparison.memoryWrite).toBe(false);
    expect(comparison.weightRecalculation).toBe("not_run");
    const unitChange = comparison.bySkill.find((skill) => skill.skillId === "unit_conversion");
    const algebra = comparison.bySkill.find((skill) => skill.skillId === "algebra");
    expect(unitChange?.previouslyStrong).toBe(true);
    expect(unitChange?.change).toBe("regressed");
    expect(unitChange?.candidateAccuracy).toBe(0);
    expect(unitChange?.missedItemIds.length).toBe(6);
    expect(algebra?.change).toBe("unchanged");
    expect(comparison.regressions.map((skill) => skill.skillId)).toEqual(["unit_conversion"]);
    expect(comparison.weakSkills.map((skill) => skill.skillId)).toEqual(["unit_conversion"]);
    expect(comparison.weakSkills[0]?.trainingProposal).toBe("not_created");
    const family = comparison.byFamily.find((row) => row.equationFamily === "affine");
    expect(family?.accuracyChange).toBe(0);
  });

  it("refuses skill comparisons across conditions or benchmark versions", async () => {
    const suite = buildMathSuite();
    const report = await runScored(suite, () => true);
    const same = compareMathBaselineSpecializations(report, report, "standard");
    expect(same.comparable).toBe(true);
    expect(same.regressions).toEqual([]);
    const mismatched = compareMathBaselineSpecializations(
      report,
      { ...report, suite: { ...report.suite, contentHash: "0".repeat(64) } },
      "standard",
    );
    expect(mismatched.comparable).toBe(false);
    expect(mismatched.reasons.join(" ")).toMatch(/benchmark versions/i);
    expect(mismatched.regressions).toEqual([]);
    expect(mismatched.overall).toBeNull();
    const standardVsThinking = compareMathBaselineSpecializations(
      retarget(report, "standard", "few_shot_thinking"),
      report,
      "few_shot_thinking",
    );
    expect(standardVsThinking.comparable).toBe(false);
    expect(standardVsThinking.regressions).toEqual([]);
  });
});

describe("C1.8A single-agent baseline", () => {
  it("scores a scripted base model without calling the colony runner", async () => {
    const suite = buildMathSuite();
    const heldOut = evaluationItems(suite);
    const provider = scripted((request) => {
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0]?.role).toBe("system");
      expect(request.messages[1]?.role).toBe("user");
      expect(request.jsonObject).toBe(false);
      expect(request.registryModelId).toBe(QWEN3_8B_MODEL_ID);
      const user = request.messages[1]?.content ?? "";
      const item = heldOut.find((candidate) => user.includes(candidate.prompt));
      const text = request.requestId.includes(":few_shot_thinking:")
        ? `working\nFINAL: ${item?.expected}`
        : request.requestId.includes(":tool_assisted:")
          ? `CALCULATOR ${item?.family}`
          : String(item?.expected);
      return result(text);
    });
    const report = await runMathBaseline({
      suite,
      model: baseModel(),
      recordedAt: "2026-11-10T00:00:00.000Z",
      gitCommit: "abcdef1234567890",
      providers: { standard: provider, fewShotThinking: provider, toolAssisted: provider },
    });
    expect(report.trained).toBe(false);
    expect(report.databaseWrites).toBe(false);
    expect(report.colonyComparison).toBe("not_run");
    expect(report.memory.forgettingCycle).toBe("not_run");
    expect(report.model.adapterId).toBeNull();
    expect(report.model.weightsVersion).toBe("base");
    expect(provider.requests).toHaveLength(heldOut.length * 3);
    for (const condition of report.conditions) {
      expect(condition.sampleSize).toBe(heldOut.length);
      expect(condition.correct).toBe(heldOut.length);
      expect(condition.accuracy).toBe(1);
      expect(condition.gate).toBe("not_applied");
      expect(condition.manifest.execution.provenance).toEqual({ state: "omitted" });
      expect(condition.manifest.model.adapterId).toEqual({ state: "disabled" });
      expect(condition.manifest.generation.retrieval).toEqual({
        state: "set",
        value: "closed_book",
      });
    }
    const standard = report.conditions.find((condition) => condition.conditionId === "standard");
    const thinking = report.conditions.find(
      (condition) => condition.conditionId === "few_shot_thinking",
    );
    const tool = report.conditions.find((condition) => condition.conditionId === "tool_assisted");
    const calculator = report.conditions.find(
      (condition) => condition.conditionId === "calculator_bound_parameters",
    );
    expect(standard?.decoding.reasoningEffort).toBe("none");
    expect(standard?.decoding.topP).toBe("omitted");
    expect(standard?.inputTokens).toBe(heldOut.length * 11);
    expect(standard?.outputTokens).toBe(heldOut.length * 3);
    expect(standard?.latencyMs).toBe(heldOut.length * 7);
    expect(standard?.items[0]?.servedModel).toBe("qwen3:8b");
    expect(thinking?.decoding.thinking).toBe("enabled");
    expect(thinking?.promptVersion).toBe("c18a-few-shot-thinking-v1");
    expect(tool?.items.every((item) => item.tool === "accepted")).toBe(true);
    expect(calculator?.modelCall).toBe(false);
    expect(calculator?.items.every((item) => item.taskCorrect)).toBe(true);
    expect(scoreCalculatorCeiling(suite).every((item) => item.taskCorrect)).toBe(true);
  });

  it("rejects calculator calls that try to override bound parameters", () => {
    const suite = buildMathSuite();
    const item = evaluationItems(suite).find(
      (candidate) => candidate.family === "tsiolkovsky_propellant",
    );
    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing rocket item");
    }
    const contaminated = gradeMathResponse({
      expected: item.expected,
      raw: "CALCULATOR tsiolkovsky_propellant 1 2 350",
      mode: "tool_or_final",
      parameters: item.parameters,
      tolerance: suite.tolerance,
    });
    expect(contaminated.tool).toBe("rejected_parameter_override");
    expect(contaminated.taskCorrect).toBe(false);
    expect(contaminated.parsed).toBeNull();

    const buried = gradeMathResponse({
      expected: item.expected,
      raw: `I think the answer is ${item.expected}`,
      mode: "number_only",
      parameters: item.parameters,
      tolerance: suite.tolerance,
    });
    expect(buried.taskCorrect).toBe(false);
    expect(buried.ambiguous).toBe(true);
  });

  it("keeps the suite and runner off the conversation and claim-extraction paths", () => {
    const suiteSource = readFileSync("packages/core/src/evaluation/math-suite.ts", "utf8");
    const runnerSource = readFileSync("packages/core/src/evaluation/math-baseline.ts", "utf8");
    const scriptSource = readFileSync("scripts/run-c18a-math-baseline.ts", "utf8");
    for (const source of [suiteSource, runnerSource, scriptSource]) {
      expect(source).not.toContain("conversation-runner");
      expect(source).not.toContain("ConversationRunner");
      expect(source).not.toContain("extractNumericalClaims");
      expect(source).not.toContain("createDatabase");
    }
  });
});

async function runScored(
  suite: ReturnType<typeof buildMathSuite>,
  correctFor: (item: ReturnType<typeof evaluationItems>[number]) => boolean,
): Promise<MathBaselineReport> {
  const heldOut = evaluationItems(suite);
  const provider = scripted((request) => {
    const user = request.messages[1]?.content ?? "";
    const item = heldOut.find((candidate) => user.includes(candidate.prompt));
    const correct = item ? correctFor(item) : false;
    const value = correct ? item?.expected : 0;
    const text = request.requestId.includes(":few_shot_thinking:")
      ? `working\nFINAL: ${value}`
      : request.requestId.includes(":tool_assisted:")
        ? `CALCULATOR ${item?.family}`
        : String(value);
    return result(text);
  });
  return runMathBaseline({
    suite,
    model: baseModel(),
    recordedAt: "2026-11-10T00:00:00.000Z",
    gitCommit: "abcdef1234567890",
    providers: { standard: provider, fewShotThinking: provider, toolAssisted: provider },
  });
}

function retarget(
  report: MathBaselineReport,
  from: MathBaselineReport["conditions"][number]["conditionId"],
  to: MathBaselineReport["conditions"][number]["conditionId"],
): MathBaselineReport {
  const source = report.conditions.find((condition) => condition.conditionId === from);
  if (!source) {
    throw new Error(`missing ${from}`);
  }
  return {
    ...report,
    conditions: report.conditions.map((condition) =>
      condition.conditionId === to ? { ...source, conditionId: to } : condition,
    ),
  };
}

function baseModel(): MathBaselineModel {
  return {
    family: "qwen3",
    alias: "qwen3:8b",
    registryModelId: QWEN3_8B_MODEL_ID,
    weightsVersion: "base",
    adapterId: null,
    installedDigest: "ab".repeat(32),
    backendId: "ollama",
    backendVersion: "test",
  };
}

function result(text: string): InferenceResult {
  return {
    text,
    servedModel: "qwen3:8b",
    servedDigest: "ab".repeat(32),
    usage: { inputTokens: 11, outputTokens: 3, source: "observed" },
    latencyMs: 7,
  };
}

function scripted(
  respond: (request: {
    messages: Array<{ role: string; content: string }>;
    jsonObject: boolean;
    registryModelId: string;
    requestId: string;
  }) => InferenceResult,
): ScriptedInferenceProvider {
  return new ScriptedInferenceProvider((request) => respond(request));
}
