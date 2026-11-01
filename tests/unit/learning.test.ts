import { assertLearningTransition, gapFingerprint, selectLearningMethod, weightImprovementVerified } from "@ai-colony/core";
import { DomainError } from "@ai-colony/core";
import { describe, expect, it } from "vitest";

describe("learning cycle policy", () => {
  it("rejects a skipped approval and a self-reported weakness", () => {
    expect(() => assertLearningTransition("OBSERVED", "EXECUTING")).toThrow(DomainError);
    expect(selectLearningMethod({ failureCount: 4, evidenceKind: "self_report", proposed: "lora" })).toBe("no_action");
    expect(selectLearningMethod({ failureCount: 1, evidenceKind: "evaluation", proposed: "lora" })).toBe("no_action");
    expect(selectLearningMethod({ failureCount: 2, evidenceKind: "evaluation", proposed: "lora" })).toBe("lora");
    expect(selectLearningMethod({ failureCount: 1, evidenceKind: "task_outcome", proposed: "knowledge_transfer" })).toBe("knowledge_transfer");
  });

  it("deduplicates a gap fingerprint for the same department and signal", () => {
    const left = gapFingerprint("dept", "arithmetic", "evaluation");
    expect(gapFingerprint("dept", "arithmetic", "evaluation")).toBe(left);
    expect(gapFingerprint("dept", "arithmetic", "tool_failure")).not.toBe(left);
  });

  it("requires a task-accuracy gain before calling a weight change verified", () => {
    expect(weightImprovementVerified({ taskBaseline: 0, taskCandidate: 0, formatBaseline: 0.3, formatCandidate: 0.2 })).toBe(false);
    expect(weightImprovementVerified({ taskBaseline: 0.2, taskCandidate: 0.4, formatBaseline: 1, formatCandidate: 0.9 })).toBe(false);
    expect(weightImprovementVerified({ taskBaseline: 0.2, taskCandidate: 0.4, formatBaseline: 0.8, formatCandidate: 0.8 })).toBe(true);
  });
});
