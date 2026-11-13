import { describe, expect, it } from "vitest";
import {
  C18D1_AUTONOMOUS_MATH_TRAINING_ENABLED,
  C18D1_EVALUATION_DEPARTMENT_ID,
  C18D1_MATH_DEPARTMENT_ID,
  C18D1_WEIGHT_DEPARTMENT_ID,
  assertCanReadLockedMathItems,
  canReadAggregateMathSummary,
  canReadLockedMathItems,
  conservativeImprovement,
  redactLockedItemFields,
  summarizeC18d1Counts,
} from "@ai-colony/core";

describe("C1.8D.1 locked access + accounting", () => {
  it("allows only Evaluation to read locked item-level data", () => {
    expect(canReadLockedMathItems({ role: "evaluation" })).toBe(true);
    expect(canReadLockedMathItems({ departmentId: C18D1_EVALUATION_DEPARTMENT_ID })).toBe(true);
    expect(canReadLockedMathItems({ departmentId: C18D1_MATH_DEPARTMENT_ID })).toBe(false);
    expect(canReadLockedMathItems({ departmentId: C18D1_WEIGHT_DEPARTMENT_ID })).toBe(false);
    expect(() => assertCanReadLockedMathItems({ role: "math" })).toThrow(/Evaluation/i);
  });

  it("allows learning agents to read aggregates but redacts item fields", () => {
    expect(canReadAggregateMathSummary({ role: "math" })).toBe(true);
    const redacted = redactLockedItemFields({
      passAt1: 0.5,
      prompt: "secret",
      expected: { kind: "roots" },
      rawPrediction: "ANSWER: 1",
    });
    expect(redacted.passAt1).toBe(0.5);
    expect(redacted.prompt).toBeUndefined();
    expect(redacted.expected).toBeUndefined();
  });

  it("keeps autonomous Math training disabled in this milestone", () => {
    expect(C18D1_AUTONOMOUS_MATH_TRAINING_ENABLED).toBe(false);
  });

  it("reports conservative bounds without double-counting truncated", () => {
    const summary = summarizeC18d1Counts({ correct: 7, wrong: 1, invalid: 1, truncated: 1 });
    expect(summary.sampleSize).toBe(10);
    expect(summary.lowerBoundAccuracy).toBe(0.7);
    expect(summary.upperBoundAccuracy).toBe(0.9);
    const improvement = conservativeImprovement(
      { correct: 0, wrong: 71, invalid: 29, truncated: 0 },
      { correct: 100, wrong: 0, invalid: 0, truncated: 0 },
    );
    expect(improvement.conservativeImprovement).toBeCloseTo(0.71);
  });
});
