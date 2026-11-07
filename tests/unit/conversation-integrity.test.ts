import { describe, expect, it } from "vitest";
import { extractJsonObject } from "@ai-colony/core";
import {
  buildCheckpoint,
  classifyClaim,
  measureProgress,
  parseModelJson,
  renderCheckpoint,
  repetitionVerdict,
  reviewMathClaim,
} from "../../packages/core/src/autonomy/conversation-integrity.js";
import { planRecovery, repetitionCorrection } from "../../packages/core/src/autonomy/conversation-quality.js";

const INSTRUCTION = "Science and Math: independently evaluate continual-learning methods. Challenge each other with mathematical reasoning, identify weaknesses, propose testable experiments, and work toward a concrete research plan.";

describe("conversation integrity", () => {
  it("keeps LaTeX commands, valid escapes, Unicode, and newlines distinct", () => {
    const latex = String.raw`{"kind":"response","body":"Use \frac{1}{2}, \nabla, \theta, \text{loss}, and \times."}`;
    const parsed = parseModelJson(latex);
    expect(parsed.repaired).toBe(true);
    expect(parsed.value).toMatchObject({ body: String.raw`Use \frac{1}{2}, \nabla, \theta, \text{loss}, and \times.` });
    expect(extractJsonObject(latex)).toMatchObject({ body: expect.stringContaining(String.raw`\frac`) });
    expect(String(extractJsonObject(latex) && (extractJsonObject(latex) as { body: string }).body)).not.toMatch(/[\u0008\u000c]/);

    const newline = String.raw`{"body":"line\nnext \u03b8"}`;
    expect(parseModelJson(newline).value).toEqual({ body: "line\nnext θ" });
    expect(parseModelJson(String.raw`{"body":"already \\frac"}`).value).toEqual({ body: String.raw`already \frac` });
  });

  it("rejects a JSON object that still contains a corrupted mathematical control", () => {
    expect(() => extractJsonObject("{\"body\":\"broken \u000c rac\"}")).toThrow(/mathematical|valid JSON/);
  });

  it("builds a checkpoint from the original instruction without clipping a word", () => {
    const checkpoint = buildCheckpoint({
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      instruction: INSTRUCTION,
      turns: [
        { id: "turn-1", department: "science", kind: "question", body: "What experimental evidence shows continual learning avoids catastrophic forgetting?", addressedDepartment: "math" },
        { id: "turn-2", department: "science", kind: "evidence", body: "The general equation of catastrophic forgetting is L = L_new + L_old.", addressedDepartment: null },
      ],
    });
    const rendered = renderCheckpoint(checkpoint);
    expect(rendered).toContain(INSTRUCTION);
    expect(rendered).toContain("message turn-1");
    expect(rendered).not.toMatch(/\w…/);
    expect(checkpoint.unverifiedAssertions.join(" ")).toContain("unsupported");
    expect(checkpoint.openQuestions[0]).toContain("owner=math");
  });

  it("flags an unsupported equation and accepts a stated derivation", () => {
    expect(reviewMathClaim("The general equation of catastrophic forgetting is L = L_new + L_old.").reasons).toEqual(
      expect.arrayContaining(["missing_assumptions", "missing_derivation"]),
    );
    expect(reviewMathClaim("Let L be dimensionless. Assume the terms add. Example: 1 kg = 1 kg because both sides use kilograms.").status).toBe("proposed");
    expect(reviewMathClaim("The force relation 3 kg = 3 m/s is proposed.").reasons).toContain("dimensional_mismatch");
    expect(classifyClaim("evidence", "The equation is established.")).toBe("unsupported");
    expect(classifyClaim("evidence", "observed: replay buffer retained task A")).toBe("verified");
    expect(classifyClaim("evidence", "Verification is pending verification.")).toBe("pending");
  });

  it("detects a repeated question and allows the same question with new evidence", () => {
    const prior = [{ kind: "question", body: "What experimental evidence shows continual learning avoids catastrophic forgetting?" }];
    expect(repetitionVerdict("Which experimental evidence demonstrates that continual learning prevents catastrophic forgetting?", prior).duplicate).toBe(true);
    expect(repetitionVerdict("What experimental evidence shows continual learning avoids catastrophic forgetting when the replay buffer is 256?", prior).duplicate).toBe(false);
  });

  it("retries repetition with a concrete contribution and bounds recovery", () => {
    const correction = repetitionCorrection("What experimental evidence is available?");
    expect(correction).toContain("repeated a recent turn");
    expect(correction).toContain("concrete calculation");
    expect(correction).toContain("criticism or limitation");
    expect(correction).toContain("proposed experiment");
    expect(correction).toContain("unresolved question");
    expect(correction).toContain("synthesis of findings");
    const math = "00000000-0000-4000-8000-000000000019";
    expect(planRecovery({ total: 0, otherDepartmentIds: [math] })).toMatchObject({ action: "handoff", departmentId: math, total: 1 });
    expect(planRecovery({ total: 1, otherDepartmentIds: [math] })).toMatchObject({ action: "synthesis", departmentId: math, total: 2 });
    expect(planRecovery({ total: 3, otherDepartmentIds: [math] }).action).toBe("close");
    expect(planRecovery({ total: 0, otherDepartmentIds: [] }).action).toBe("close");
  });

  it("does not treat ten turns as substantial progress", () => {
    const checkpoint = buildCheckpoint({
      topic: "continual learning",
      instruction: INSTRUCTION,
      turns: Array.from({ length: 10 }, (_, index) => ({
        id: `turn-${index}`,
        department: index % 2 === 0 ? "science" : "math",
        kind: "question",
        body: `Open issue ${index} remains.`,
        addressedDepartment: null,
      })),
    });
    expect(measureProgress(checkpoint, 10)).toMatchObject({ substantial: false });
    checkpoint.decisions.push("message decision: the plan is accepted");
    expect(measureProgress(checkpoint, 10).substantial).toBe(true);
  });
});
