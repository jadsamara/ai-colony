import { createHash } from "node:crypto";
import {
  ACCEPTANCE_CRITERIA,
  applyReserved,
  assertInsideRoot,
  assertNotSelfDecision,
  assertTrainingTransition,
  assignSplit,
  buildCuratedArithmetic,
  exampleFromMemory,
  examplesFromSupplied,
  frozenConfig,
  meetsAcceptance,
  parseArithmetic,
  ROLE_PERMISSIONS,
  scoreOutputs,
  TRAINING_BUDGETS,
  trainingScript,
} from "@ai-colony/core";
import { describe, expect, it } from "vitest";

describe("training datasets and governance", () => {
  it("keeps approval and promotion away from agents that can propose", () => {
    expect(ROLE_PERMISSIONS.department_agent.has("training:propose")).toBe(true);
    expect(ROLE_PERMISSIONS.department_agent.has("training:approve")).toBe(false);
    expect(ROLE_PERMISSIONS.department_agent.has("training:execute")).toBe(false);
    expect(ROLE_PERMISSIONS.department_agent.has("model:candidate:promote")).toBe(false);
    expect(ROLE_PERMISSIONS.ceo_agent.has("training:propose")).toBe(true);
    expect(ROLE_PERMISSIONS.ceo_agent.has("training:approve")).toBe(false);
    expect(ROLE_PERMISSIONS.ceo_agent.has("model:candidate:promote")).toBe(false);
    expect(ROLE_PERMISSIONS.system_administrator.has("training:approve")).toBe(true);
    expect(() => assertNotSelfDecision({ agentId: "agent", principalId: "agent" }, "agent")).toThrow(/own training/);
    expect(() => assertNotSelfDecision({ agentId: null, principalId: "admin" }, "admin")).not.toThrow();
  });

  it("canonicalizes commutative paraphrases into one split and rejects model output as truth", () => {
    const first = parseArithmetic("Compute 4 + 3 please");
    const second = parseArithmetic("3 + 4");
    expect(first?.groupKey).toBe("+:3:4");
    expect(first?.groupKey).toBe(second?.groupKey);
    expect(first?.expectedOutput).toBe("7");
    const supplied = examplesFromSupplied(["4 + 3", "what is 3 + 4?", "9 - 1"], 7);
    expect(supplied.accepted).toHaveLength(1);
    expect(supplied.rejected.map((row) => row.reason)).toEqual(["near_duplicate", "unverified_expression"]);
    expect(exampleFromMemory({ id: "m", status: "validated", provenance: "model_generated", content: "INPUT: 1 + 1\nOUTPUT: 2" }, 7)).toEqual({
      rejected: { input: "m", reason: "model_generated" },
    });
    expect(exampleFromMemory({ id: "m", status: "validated", provenance: "user_provided", content: "INPUT: 1 + 1\nOUTPUT: 3" }, 7)).toEqual({
      rejected: { input: "m", reason: "output_mismatch" },
    });
  });

  it("does not let a group cross splits, including groups already held out", () => {
    const rows = buildCuratedArithmetic(48, 7);
    expect(rows.length).toBeLessThanOrEqual(TRAINING_BUDGETS.maxExamples);
    const bySplit = new Map<string, Set<string>>();
    for (const row of rows) {
      const bucket = bySplit.get(row.split) ?? new Set<string>();
      bucket.add(row.groupKey);
      bySplit.set(row.split, bucket);
      expect(row.split).toBe(assignSplit(row.groupKey, 7));
    }
    expect(bySplit.get("train")?.size).toBeGreaterThanOrEqual(8);
    expect(bySplit.get("validation")?.size).toBeGreaterThanOrEqual(4);
    expect(bySplit.get("test")?.size).toBeGreaterThanOrEqual(4);
    const testKey = [...(bySplit.get("test") ?? [])][0]!;
    expect([...(bySplit.get("train") ?? [])].includes(testKey)).toBe(false);
    const reserved = applyReserved([{ groupKey: testKey, split: "train" as const }], new Set([testKey]));
    expect(reserved[0]?.split).toBe("test");
  });

  it("rejects a candidate whose loss fell but whose held-out score did not improve", () => {
    const baseline = scoreOutputs(["4"], ["0"], 3, 0);
    const candidate = scoreOutputs(["4"], ["0"], 3, 0);
    expect(baseline.numericCorrectness).toBe(0);
    expect(meetsAcceptance(baseline, candidate, ACCEPTANCE_CRITERIA)).toBe(false);
    const improved = scoreOutputs(["4"], ["4"], 3, 0);
    expect(meetsAcceptance(baseline, improved, ACCEPTANCE_CRITERIA)).toBe(true);
    expect(() => assertTrainingTransition("proposed", "training")).toThrow(/Cannot move/);
    expect(() => assertTrainingTransition("failed", "queued")).not.toThrow();
  });

  it("allowlists the trainer command and refuses paths that escape the root", () => {
    const config = frozenConfig(7, "a".repeat(64), "b".repeat(64));
    expect(config.steps).toBeLessThanOrEqual(TRAINING_BUDGETS.maxSteps);
    expect(config.family).toBe("gemma-3");
    expect(config.parameterCount).toBe(270_000_000);
    expect(() => assertInsideRoot("/tmp/colony-root", "/tmp/colony-root/../etc/passwd")).toThrow(/escapes/);
    expect(() => trainingScript("/tmp/colony-training", "rm.py")).toThrow(/allowlisted/);
    expect(createHash("sha256").update("gemma").digest("hex")).toHaveLength(64);
  });
});
