import { describe, expect, it } from "vitest";
import {
  classifyDecisionParseFailure,
  classifyFailure,
  DECISION_RESPONSE_JSON_SCHEMA,
  inspectDecision,
  looksTruncatedJson,
  stripModelWrappers,
} from "@ai-colony/core";

describe("C1.7.4D structured decision reliability", () => {
  it("exposes a JSON schema suitable for Ollama structured outputs", () => {
    expect(DECISION_RESPONSE_JSON_SCHEMA.required).toEqual(["kind", "body"]);
    expect(DECISION_RESPONSE_JSON_SCHEMA.properties.kind.enum).toContain("proposal");
    expect(DECISION_RESPONSE_JSON_SCHEMA.properties.kind.enum).not.toContain("essay");
  });

  it("strips think wrappers before JSON inspection without inventing content", () => {
    const wrapped = `<think>internal draft</think>\n{"kind":"response","body":"Premise A conflicts with B on units."}`;
    expect(stripModelWrappers(wrapped)).toBe('{"kind":"response","body":"Premise A conflicts with B on units."}');
    const inspected = inspectDecision(wrapped);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.value.body).toContain("Premise A");
    }
  });

  it("classifies malformed JSON separately from wrong-schema JSON", () => {
    const malformed = inspectDecision("not-json-at-all");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.failureKind).toBe("json_invalid");
      expect(malformed.diagnostic).toMatch(/not a JSON object|not valid JSON/);
    }

    const wrongSchema = inspectDecision(JSON.stringify({ kind: "essay", body: "An essay is not allowed." }));
    expect(wrongSchema.ok).toBe(false);
    if (!wrongSchema.ok) {
      expect(wrongSchema.failureKind).toBe("schema_invalid");
      expect(wrongSchema.diagnostic).toContain("kind: invalid value");
    }
  });

  it("detects truncated JSON and unclosed think blocks", () => {
    const truncated = '{"kind":"response","body":"incomplete';
    expect(looksTruncatedJson(truncated)).toBe(true);
    const classified = classifyDecisionParseFailure(truncated, new Error("output was not valid JSON"));
    expect(classified.kind).toBe("truncated");
    expect(classified.reason).toContain("truncated");

    const unclosedThink = "<think>still thinking about JSON";
    expect(looksTruncatedJson(unclosedThink)).toBe(true);
    const inspected = inspectDecision(unclosedThink);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) {
      expect(["truncated", "json_invalid"]).toContain(inspected.failureKind);
    }
  });

  it("does not confuse invalid JSON with repeated valid content in failure taxonomy", () => {
    const jsonAfterRepetition = classifyFailure("model_invalid: output was not valid JSON", "invalid_after_repetition");
    expect(jsonAfterRepetition.failureClass).toBe("json_invalid");

    const schemaAfterRepetition = classifyFailure("model_invalid: kind: invalid value; allowed: question|response", "invalid_after_repetition");
    expect(schemaAfterRepetition.failureClass).toBe("schema_invalid");

    const repetitive = classifyFailure("near-verbatim duplicate of prior proposal", "repetitive");
    expect(repetitive.failureClass).toBe("repetition");
    expect(repetitive.failureClass).not.toBe("json_invalid");
  });
});
