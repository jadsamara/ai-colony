import { describe, expect, it } from "vitest";
import { correctionInstruction, DECISION_JSON_SCHEMA, inspectDecision } from "../../packages/core/src/autonomy/conversation-runner.js";

const secret = `SECRET-MODEL-OUTPUT-${"x".repeat(500)}`;

describe("conversation decision parsing", () => {
  it("rejects malformed JSON without storing the model text", () => {
    const inspected = inspectDecision(`not json at all ${secret}`);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) {
      return;
    }
    expect(inspected.diagnostic).toBe("model_invalid: output was not a JSON object");
    expect(inspected.diagnostic).not.toContain("SECRET-MODEL-OUTPUT");
    expect(inspected.diagnostic.length).toBeLessThanOrEqual(240);
  });

  it("reports a missing body without inventing one", () => {
    const inspected = inspectDecision('{"kind":"response","addressedSlug":"science"}');
    expect(inspected.ok).toBe(false);
    if (inspected.ok) {
      return;
    }
    expect(inspected.diagnostic).toContain("body:");
    expect(inspected.diagnostic.startsWith("model_invalid:")).toBe(true);
    expect(inspected.diagnostic).not.toContain("science");
  });

  it("reports an invalid kind without echoing the received value", () => {
    const inspected = inspectDecision(`{"kind":"${secret}","body":"hello"}`);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) {
      return;
    }
    expect(inspected.diagnostic).toContain("kind: invalid value");
    expect(inspected.diagnostic).not.toContain("SECRET-MODEL-OUTPUT");
    expect(inspected.diagnostic.length).toBeLessThanOrEqual(240);
  });

  it("builds one correction prompt from the schema, the validation errors, and the previous output", () => {
    const previous = `{"kind":"essay","body":""} postgres://colony:secret@db/colony ${secret}`;
    const diagnostic = inspectDecision(previous);
    expect(diagnostic.ok).toBe(false);
    if (diagnostic.ok) {
      return;
    }
    const correction = correctionInstruction(previous, diagnostic.diagnostic);
    expect(correction).toContain("Validation errors:");
    expect(correction).toContain(diagnostic.diagnostic);
    expect(correction).toContain("Previous output:");
    expect(correction).toContain('{"kind":"essay","body":""}');
    expect(correction).toContain(DECISION_JSON_SCHEMA);
    expect(correction).toContain("kind is required");
    expect(correction).toContain("body is required");
    expect(correction).toContain("[redacted]");
    expect(correction).not.toContain("postgres://colony:secret@db/colony");
    expect(correction).not.toContain(secret);
  });
});
