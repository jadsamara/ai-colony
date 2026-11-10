/**
 * C1.7.4D structured decision output helpers.
 * Separates JSON parse failures from schema/contribution failures and repetition.
 */

export const DECISION_KINDS = [
  "question",
  "response",
  "proposal",
  "challenge",
  "evidence",
  "counterargument",
  "agreement",
  "disagreement",
  "resolution",
  "close",
] as const;

export type DecisionFailureKind =
  | "json_invalid"
  | "schema_invalid"
  | "contribution_invalid"
  | "serialization_error"
  | "truncated";

/** JSON Schema for Ollama / OpenAI-compatible structured outputs (grammar constraint). */
export const DECISION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [...DECISION_KINDS],
    },
    body: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
    },
    addressedSlug: { type: "string" },
    inviteSlug: { type: "string" },
    decision: {
      type: "string",
      enum: ["speak", "accept", "decline"],
    },
    searchQuery: { type: "string" },
    workingGroup: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64 },
      maxItems: 4,
    },
  },
  required: ["kind", "body"],
} as const;

/**
 * Strip model wrappers that commonly break JSON parsing (Qwen3 think blocks).
 * Does not invent content; only removes known non-JSON wrappers.
 */
export function stripModelWrappers(text: string): string {
  let out = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  // Unclosed think block: drop from the opening tag onward so trailing JSON can surface if present.
  out = out.replace(/<think\b[^>]*>[\s\S]*$/i, "");
  return out.trim();
}

export function looksTruncatedJson(text: string): boolean {
  if (/<think\b[^>]*>/i.test(text) && !/<\/think>/i.test(text)) {
    return true;
  }
  const stripped = stripModelWrappers(text);
  const start = stripped.indexOf("{");
  if (start < 0) {
    return false;
  }
  const slice = stripped.slice(start);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < slice.length; index += 1) {
    const ch = slice[index] ?? "";
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return false;
      }
    }
  }
  return depth > 0 || /<think\b[^>]*>/i.test(text);
}

export function classifyDecisionParseFailure(raw: string, error: Error): {
  kind: DecisionFailureKind;
  reason: string;
} {
  const message = error.message;
  if (message.includes("mathematical") || message.includes("corrupted")) {
    return { kind: "serialization_error", reason: "mathematical notation was corrupted by a JSON escape" };
  }
  if (looksTruncatedJson(raw) || /<think\b[^>]*>/i.test(raw) && !/<\/think>/i.test(raw)) {
    return { kind: "truncated", reason: "output JSON appears truncated" };
  }
  if (message.includes("did not contain a JSON object")) {
    return { kind: "json_invalid", reason: "output was not a JSON object" };
  }
  return { kind: "json_invalid", reason: "output was not valid JSON" };
}
