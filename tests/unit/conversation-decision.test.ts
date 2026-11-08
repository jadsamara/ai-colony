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
    expect(inspected.diagnostic).toContain("allowed:");
    expect(inspected.diagnostic).toContain("response");
    expect(inspected.diagnostic).not.toContain("SECRET-MODEL-OUTPUT");
    expect(inspected.diagnostic.length).toBeLessThanOrEqual(240);
  });

  it("rejects essay as an invalid kind and keeps the schema enum explicit", () => {
    const inspected = inspectDecision(JSON.stringify({ kind: "essay", body: "A long analytical essay about forgetting." }));
    expect(inspected.ok).toBe(false);
    if (inspected.ok) {
      return;
    }
    expect(inspected.diagnostic).toContain("kind: invalid value");
    expect(DECISION_JSON_SCHEMA).toContain("Do not invent kinds such as essay");
    expect(DECISION_JSON_SCHEMA).toContain("question|response|proposal");
  });

  it("builds a clean correction prompt without leaking the previous model output into research context", () => {
    const previous = `{"kind":"essay","body":""} postgres://colony:secret@db/colony ${secret}`;
    const diagnostic = inspectDecision(previous);
    expect(diagnostic.ok).toBe(false);
    if (diagnostic.ok) {
      return;
    }
    const correction = correctionInstruction(previous, diagnostic.diagnostic);
    expect(correction).toContain("Reason:");
    expect(correction).toContain(diagnostic.diagnostic);
    expect(correction).toContain(DECISION_JSON_SCHEMA);
    expect(correction).toContain("body must be research content only");
    expect(correction).not.toContain("Previous output:");
    expect(correction).not.toContain("postgres://colony:secret@db/colony");
    expect(correction).not.toContain(secret);
  });

  it("rejects parser-validation explanations that masquerade as research bodies", () => {
    const inspected = inspectDecision(JSON.stringify({
      kind: "response",
      body: "The previous JSON failed validation because it did not include the required fields 'kind' and 'body'. Here is the corrected JSON object with the required fields.",
      decision: "speak",
    }));
    expect(inspected.ok).toBe(false);
    if (inspected.ok) {
      return;
    }
    expect(inspected.diagnostic).toContain("parser or validation");
  });
});
