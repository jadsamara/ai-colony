import { describe, expect, it } from "vitest";
import { assertMethodExecutable, assertSafeConfig, isHighRisk, planExperiments, selectDevelopmentCandidate, TRAINING_METHODS } from "../../packages/core/src/training/experiment-planner.js";
import { meanExposures, outputDisagreement, stopDecision } from "../../packages/core/src/training/stability.js";
import { generateProblems } from "../../research/m75/arithmetic.js";
import { INTERMEDIATE_CELLS } from "../../research/m75/protocol.js";
import { sha256File } from "../../research/m75/io.js";
import { structuredSteps, structuredTarget, lossSpanRejectsPrompt } from "../../research/m75b/solutions.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const history = ["self-101", "supervised-101", "self-202", "supervised-202", "self-303", "supervised-303"].map((id, index) => ({
  id,
  methodId: id.startsWith("self") ? "verified-rejection-sft" : "lora-supervised",
  steps: 80,
  learningRate: 0.0001,
  datasetSize: 25,
  target: "answer" as const,
  seed: 101,
  devAccuracy: null,
  baselineAccuracy: 134 / 300,
  sealedAccuracy: [27, 37, 38, 29, 33, 54][index]! / 300,
  retentionOk: id !== "supervised-202",
  failureClass: "regression",
  evidencePath: `services/training/results/m75/evals/${id}.jsonl`,
}));

describe("M7.5B experiment planner", () => {
  it("registers only implemented methods as executable", () => {
    expect(TRAINING_METHODS.filter((method) => method.status === "implemented").map((method) => method.id)).toEqual(["lora-supervised", "verified-rejection-sft", "structured-solution-sft"]);
    expect(() => assertMethodExecutable("reinforcement-learning", "qwen3")).toThrow(/cannot train/);
    expect(assertMethodExecutable("lora-supervised", "qwen3").version).toBe("m75b-v1");
  });

  it("is reproducible and treats the M7.5 configuration as high risk", () => {
    const first = planExperiments({ problem: "arithmetic", history, budgetMaxSteps: 40, baseAccuracy: 0.45 });
    const second = planExperiments({ problem: "arithmetic", history, budgetMaxSteps: 40, baseAccuracy: 0.45 });
    expect(first).toEqual(second);
    expect(first.find((item) => item.action === "reject-configuration")?.citedExperimentIds).toHaveLength(6);
    expect(first.every((item) => item.deployment === "ineligible")).toBe(true);
    expect(first.find((item) => item.action === "smaller-update")?.config).toMatchObject({ learningRate: 0.00001, steps: 5 });
    expect(isHighRisk(history[0]!)).toBe(true);
  });

  it("withholds execution when the step budget is too small", () => {
    const plan = planExperiments({ problem: "arithmetic", history, budgetMaxSteps: 0, baseAccuracy: 0.45 });
    expect(plan.find((item) => item.action === "smaller-update")?.executable).toBe(false);
    expect(plan.find((item) => item.action === "zero-step-control")?.executable).toBe(true);
  });

  it("stops on regression, memory, budget, and missing evidence", () => {
    expect(stopDecision({ baselineAccuracy: 0.5, candidateAccuracy: 0.3, peakMemoryBytes: 1, steps: 5, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true }).reason).toMatch(/regressed/);
    expect(stopDecision({ baselineAccuracy: 0.5, candidateAccuracy: 0.5, peakMemoryBytes: 20_000_000_000, steps: 5, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true }).reason).toMatch(/memory/);
    expect(stopDecision({ baselineAccuracy: 0.5, candidateAccuracy: 0.5, peakMemoryBytes: null, steps: 201, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: true }).reason).toMatch(/budget/);
    expect(stopDecision({ baselineAccuracy: null, candidateAccuracy: null, peakMemoryBytes: null, steps: 5, lossFinite: true, datasetValid: false, modelCompatible: true, evaluationPresent: true }).reason).toMatch(/dataset/);
    expect(stopDecision({ baselineAccuracy: null, candidateAccuracy: null, peakMemoryBytes: null, steps: 5, lossFinite: false, datasetValid: true, modelCompatible: true, evaluationPresent: true }).reason).toMatch(/finite/);
    expect(stopDecision({ baselineAccuracy: null, candidateAccuracy: null, peakMemoryBytes: null, steps: 5, lossFinite: true, datasetValid: true, modelCompatible: false, evaluationPresent: true }).reason).toMatch(/incompatible/);
    expect(stopDecision({ baselineAccuracy: null, candidateAccuracy: null, peakMemoryBytes: null, steps: 5, lossFinite: true, datasetValid: true, modelCompatible: true, evaluationPresent: false }).reason).toMatch(/evidence/);
  });

  it("calculates exposure and refuses a sealed item in training", () => {
    expect(meanExposures(80, 25)).toBeCloseTo(3.2);
    expect(meanExposures(5, 250)).toBeCloseTo(0.02);
    expect(meanExposures(50, 250)).toBeCloseTo(meanExposures(5, 25));
    expect(() => assertSafeConfig({ steps: 5, learningRate: 1e-5, datasetSize: 25, sealedItemIds: ["same"], trainItemIds: ["same"] })).toThrow(/sealed/);
    expect(() => assertSafeConfig({ steps: 201, learningRate: 1e-5, datasetSize: 25, sealedItemIds: [], trainItemIds: [] })).toThrow(/budget/);
  });

  it("selects the least damaging configuration without ignoring a severe one when nothing is safe", () => {
    const chosen = selectDevelopmentCandidate([
      { id: "large", devAccuracy: 0.1, learningRate: 1e-4, steps: 40, severe: true },
      { id: "small", devAccuracy: 0.4, learningRate: 1e-5, steps: 5, severe: true },
    ]);
    expect(chosen?.id).toBe("small");
  });

  it("compares zero-update outputs and keeps an initialized adapter from counting as a change in the scorer", () => {
    expect(outputDisagreement(["4", "4"], ["4", "4"])).toEqual({ compared: 2, changed: 0 });
    expect(outputDisagreement(["4", "9"], ["4", "8"]).changed).toBe(1);
  });

  it("builds verified structured solutions and isolates splits", () => {
    const cell = INTERMEDIATE_CELLS.find((item) => item.id === "asm3-30");
    if (cell === undefined) {
      throw new Error("missing cell");
    }
    const steps = structuredSteps("23 - 21 * 24");
    expect(steps[steps.length - 1]?.value).toBe(23 - 21 * 24);
    expect(structuredTarget("15 - 2 + 4")).toContain("15 - 2 = 13");
    expect(lossSpanRejectsPrompt("17<|im_end|>")).toBe(true);
    const first = generateProblems(cell, "a", 25, 1);
    const second = generateProblems(cell, "b", 25, 2, { canonicals: new Set(first.map((item) => item.canonical)), templates: new Set(first.map((item) => item.templateKey)) });
    const canonicals = new Set([...first, ...second].map((item) => item.canonical));
    expect(canonicals.size).toBe(50);
    const directory = mkdtempSync(join(tmpdir(), "adapter-"));
    const file = join(directory, "adapters.safetensors");
    writeFileSync(file, "adapter-bytes");
    expect(sha256File(file)).toHaveLength(64);
  });
});
