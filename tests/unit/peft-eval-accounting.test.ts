import { describe, expect, it } from "vitest";
import { classifyPredictionOutcome, evaluationValidity } from "@ai-colony/core";

describe("C1.8D shared eval accounting", () => {
  it("counts truncated thinking-only outputs as invalid, not wrong", () => {
    // Mirrors peft_eval_common.score_prediction semantics at the TypeScript gate layer.
    expect(classifyPredictionOutcome({ exactMatch: false, invalid: true })).toBe("invalid");
    expect(evaluationValidity({ invalidRate: 24 / 24 }).evaluationValid).toBe(false);
  });

  it("allows a fair pass only when invalid rate stays within 5%", () => {
    expect(evaluationValidity({ invalidRate: 1 / 24 }).evaluationValid).toBe(true);
    expect(evaluationValidity({ invalidRate: 2 / 24 }).evaluationValid).toBe(false);
  });
});
