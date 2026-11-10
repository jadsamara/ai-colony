import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  buildMathSuite,
  evaluationItems,
  extractNumericalClaims,
  fewShotExamples,
  gradeMathResponse,
  renderFewShotUser,
  runMathBaseline,
  scoreCalculatorCeiling,
  solveMathItem,
  tsiolkovskyPropellantMass,
  verifyFrozenMathSuite,
  type InferenceResult,
  type MathBaselineModel,
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
