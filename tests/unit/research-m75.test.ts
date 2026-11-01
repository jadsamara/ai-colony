import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mcnemarExact as coreMcnemar } from "@ai-colony/core";
import { GATE_POLICY } from "@ai-colony/core";
import { IMPROVEMENT_POLICY } from "@ai-colony/core";
import { describe, expect, it } from "vitest";
import { allocationFor, assertResearchModel, assertTrainBudget, concludeResearch, continueSelfTraining, frozenTrainConfig, phase1Decision, recoverTraining, selectCalibrationCell } from "../../research/m75/analysis.js";
import { assertDisjoint, evaluateExpression, generateProblems, templateKey } from "../../research/m75/arithmetic.js";
import { assertNoCanonicalLeak, matchSupervised, verifiedExamples } from "../../research/m75/datasets.js";
import { scoreInteger } from "../../research/m75/extract.js";
import { CALIBRATION_CELLS } from "../../research/m75/protocol.js";
import { compareRuns, type StoredEval } from "../../research/m75/score.js";
import { mcnemarExact } from "../../research/m75/stats.js";
import { PATHS } from "../../research/m75/worker.js";

describe("M7.5 arithmetic generator", () => {
  it("evaluates addition, subtraction, precedence, and negative results", () => {
    expect(evaluateExpression("37 + 18 - 9")).toBe(46);
    expect(evaluateExpression("64 - 27 + 13")).toBe(50);
    expect(evaluateExpression("125 - 48 - 16")).toBe(61);
    expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateExpression("8 - 3 - 2")).toBe(3);
    expect(evaluateExpression("5 - 9")).toBe(-4);
  });

  it("repeats a seed and rejects duplicate templates", () => {
    const cell = CALIBRATION_CELLS[2];
    if (cell === undefined) {
      throw new Error("missing cell");
    }
    const first = generateProblems(cell, "development", 20, 11004);
    const second = generateProblems(cell, "development", 20, 11004);
    expect(second.map((problem) => problem.itemId)).toEqual(first.map((problem) => problem.itemId));
    expect(new Set(first.map((problem) => problem.templateKey)).size).toBe(first.length);
    const other = generateProblems(cell, "sealed", 20, 11005, {
      canonicals: new Set(first.map((problem) => problem.canonical)),
      templates: new Set(first.map((problem) => problem.templateKey)),
    });
    assertDisjoint([first, other]);
  });

  it("detects exact leakage", () => {
    const cell = CALIBRATION_CELLS[0];
    if (cell === undefined) {
      throw new Error("missing cell");
    }
    const problems = generateProblems(cell, "train", 5, 3);
    const first = problems[0];
    if (first === undefined) {
      throw new Error("missing problem");
    }
    expect(() => assertNoCanonicalLeak([first.canonical], [first.canonical])).toThrow(/held-out/);
    expect(templateKey(first.operators, first.operands)).toBe(first.templateKey);
  });
});

describe("M7.5 scoring and datasets", () => {
  it("accepts an equation and a bare integer without training on the raw response", () => {
    expect(scoreInteger("37 + 18 - 9 = 46", 46).correct).toBe(true);
    expect(scoreInteger("46", 46).exactFormat).toBe(true);
    expect(scoreInteger("the answer is 46", 45).correct).toBe(false);
    expect(scoreInteger("no number here", 4).formatValid).toBe(false);
    const cell = CALIBRATION_CELLS[1];
    if (cell === undefined) {
      throw new Error("missing cell");
    }
    const [item] = generateProblems(cell, "experience", 1, 9);
    if (item === undefined) {
      throw new Error("missing item");
    }
    const verified = verifiedExamples([
      { item, attemptId: "0", response: `I think it is ${item.expected}`, seed: 1 },
      { item, attemptId: "1", response: "not a number", seed: 2 },
      { item, attemptId: "2", response: String(item.expected + 1), seed: 3 },
    ]);
    expect(verified.examples).toHaveLength(1);
    expect(verified.examples[0]?.assistant).toBe(String(item.expected));
    expect(verified.examples[0]?.assistant).not.toContain("think");
    expect(verified.unparseableAttempts).toBe(1);
    expect(verified.incorrectAttempts).toBe(1);
  });

  it("matches supervised examples to the verified difficulty counts", () => {
    const cell = CALIBRATION_CELLS[3];
    if (cell === undefined) {
      throw new Error("missing cell");
    }
    const pool = generateProblems(cell, "supervised-pool", 40, 22);
    const verified = generateProblems(cell, "experience", 20, 23, {
      canonicals: new Set(pool.map((problem) => problem.canonical)),
      templates: new Set(pool.map((problem) => problem.templateKey)),
    }).map((problem) => ({
      itemId: problem.itemId,
      prompt: problem.prompt,
      assistant: String(problem.expected),
      expected: problem.expected,
      difficultyKey: problem.difficultyKey,
      canonical: problem.canonical,
      source: "self_verified" as const,
    }));
    const matched = matchSupervised(verified, pool);
    expect(matched.supervised).toHaveLength(matched.self.length);
    expect(matched.supervised.every((example) => example.source === "programmatic")).toBe(true);
    expect(matched.self.every((example) => example.assistant === String(example.expected))).toBe(true);
  });
});

describe("M7.5 analysis", () => {
  it("selects an in-band cell with enough combinatorial space", () => {
    const selected = selectCalibrationCell(
      [
        { id: "add2-9", accuracy: 0.45, sampleSize: 16 },
        { id: "as3-99", accuracy: 0.47, sampleSize: 16 },
      ],
      [
        { id: "add2-9", termCount: 2, operandMin: 1, operandMax: 9, operators: ["+"] },
        { id: "as3-99", termCount: 3, operandMin: 1, operandMax: 99, operators: ["+", "-"] },
      ],
    );
    expect(selected.id).toBe("as3-99");
    expect(selected.inBand).toBe(true);
    expect(allocationFor({ id: "as3-99", termCount: 3, operandMin: 1, operandMax: 99, operators: ["+", "-"] }).sealed).toBe(300);
  });

  it("keeps the frozen policies and refuses promotion", () => {
    expect(IMPROVEMENT_POLICY.version).toBe("m7h-improvement-v1");
    expect(IMPROVEMENT_POLICY.minAbsoluteTaskGain).toBe(0.1);
    expect(GATE_POLICY.version).toBe("m6-gate-v1");
    expect(GATE_POLICY.minSampleForPass).toBe(30);
    expect(phase1Decision("POSITIVE_EVIDENCE")).toMatchObject({ promoted: false, deployment: "ineligible" });
    expect(concludeResearch({ valid: false, retentionFailed: false, difference: 0.2, pValue: 0.01, sampleSize: 300 })).toBe("EVALUATION_INVALID");
    expect(concludeResearch({ valid: true, retentionFailed: false, difference: 0.2, pValue: null, sampleSize: 300 })).toBe("EVALUATION_INVALID");
    expect(concludeResearch({ valid: true, retentionFailed: false, difference: 0.02, pValue: 0.2, sampleSize: 300 })).toBe("INCONCLUSIVE");
    expect(concludeResearch({ valid: true, retentionFailed: true, difference: 0.2, pValue: 0.001, sampleSize: 300 })).toBe("RETENTION_FAILURE");
    expect(frozenTrainConfig().targetModules).toEqual(["q_proj", "v_proj"]);
    expect(() => assertTrainBudget({ ...frozenTrainConfig(), steps: 201 })).toThrow(/budget/);
    expect(() => assertResearchModel("qwen3:8b")).toThrow(/allowlisted/);
    expect(recoverTraining({ cancelled: true, artifactPath: null, retries: 0 })).toMatchObject({ status: "cancelled", retry: false, duplicateAdapter: false });
    expect(recoverTraining({ cancelled: false, artifactPath: null, retries: 0 })).toMatchObject({ status: "failed", retry: true, duplicateAdapter: false });
    expect(continueSelfTraining({ round: 1, devGain: 0.01, retentionOk: true, verifiedExamples: 20 }).continue).toBe(false);
  });

  it("matches the stable McNemar implementation to the core test for small counts", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(3, 10)).toBeCloseTo(coreMcnemar(3, 10), 9);
  });

  it("does not claim a paired result when item ids differ", () => {
    const baseline = [fake("a", true)];
    const candidate = [fake("b", true)];
    expect(compareRuns(baseline, candidate, false).conclusion).toBe("EVALUATION_INVALID");
  });
});

describe("M7.5 worker allowlist", () => {
  it("rejects a Gemma profile before loading MLX", () => {
    mkdirSync(PATHS.artifacts, { recursive: true });
    const directory = mkdtempSync(join(PATHS.artifacts, "unit-"));
    mkdirSync(directory, { recursive: true });
    const job = join(directory, "job.json");
    writeFileSync(job, JSON.stringify({ profile: "gemma3-270m-math-v1", family: "gemma-3", command: "validate" }));
    const result = spawnSync(PATHS.python, [PATHS.script, "--job", job], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/allowlist|escapes|Gemma/);
  });
});

function fake(itemId: string, correct: boolean): StoredEval {
  return {
    experimentId: "m75-phase1",
    evaluationRunId: "unit",
    itemId,
    split: "sealed",
    datasetVersion: "arith-m75-v1",
    prompt: "Compute the value of the expression. Reply with the integer result only.\nExpression: 1 + 1",
    response: correct ? "2" : "3",
    expectedAnswer: 2,
    scoreMode: "integer",
    modelId: "Qwen/Qwen3-1.7B-MLX-4bit",
    modelRevision: "test",
    adapterId: null,
    adapterSha256: null,
    seed: 0,
    decoding: {},
    attemptId: "0",
  };
}
