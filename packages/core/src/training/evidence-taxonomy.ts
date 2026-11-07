export const FAILURE_CLASSES = [
  "json_invalid",
  "schema_invalid",
  "serialization_error",
  "meta_validation_chatter",
  "repetition",
  "context_missing",
  "orchestration_failure",
  "math_unverified",
  "unsupported_evidence",
  "reasoning_error",
  "inference_timeout",
  "inference_error",
  "unknown",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const ACCEPTANCE_STATUSES = ["accepted", "rejected", "recovered", "failed", "partial"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export const CLASSIFICATION_SOURCES = ["runtime", "human", "evaluation", "system"] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const CLASSIFICATION_CONFIDENCE = ["observed", "provisional", "reviewed", "verified"] as const;
export type ClassificationConfidence = (typeof CLASSIFICATION_CONFIDENCE)[number];

export const ELIGIBILITY_STATUSES = ["not_reviewed", "ineligible", "candidate", "verified_for_dataset"] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const CORRECTION_STATUSES = ["unverified", "verified", "rejected"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export interface FailureClassification {
  failureClass: FailureClass;
  /** Observed symptom — what the runtime saw. */
  symptom: string;
  /**
   * Inferred root cause, if any. Runtime never asserts verified model-capability
   * failure from a single conversation symptom.
   */
  rootCause: string | null;
  provisional: boolean;
  confidence: ClassificationConfidence;
  source: ClassificationSource;
  evidence: string;
}

const META = /json validation|return one json|schema|formatting|previous generation was rejected|parser or validation|validation explanation|validation instructions/i;
const MATH = /math_unverified|equation|derivation|unverified math|cannot verify/i;
const SERIALIZATION = /mathematical notation was corrupted|json escape|serialization/i;
const SCHEMA = /did not match the schema|invalid value|required|kind:|body:/i;
const JSON = /not valid json|not a json object|output was not/i;
const REPETITION = /repetit|near.?verbatim|duplicate|same objection|already said/i;
const CONTEXT = /context_missing|missing context|omitted transcript/i;
const ORCH = /orchestration|no_speaker|lease|budget/i;
const TIMEOUT = /timeout|timed out|AbortError/i;
const INFER = /inference_error|provider|ollama|ECONNREFUSED|5\d\d/i;
const EVIDENCE = /unsupported_evidence|invent(ed)? citation|unsupported claim/i;

/**
 * Map a runtime diagnostic to an observed failure class.
 * Never promotes repetition or formatting symptoms to verified reasoning_error.
 */
export function classifyFailure(diagnostic: string, reason?: string): FailureClassification {
  const text = `${reason ?? ""} ${diagnostic}`.trim();
  if (TIMEOUT.test(text)) {
    return observed("inference_timeout", text, "Provider timed out");
  }
  if (INFER.test(text) && !JSON.test(text) && !SCHEMA.test(text)) {
    return observed("inference_error", text, "Provider or transport failure");
  }
  if (SERIALIZATION.test(text)) {
    return observed("serialization_error", text, "Output serialization broke structured parsing");
  }
  if (JSON.test(text) || reason === "invalid_output" || reason === "invalid_after_repetition") {
    if (SCHEMA.test(text) && !/not valid json|not a json object/i.test(text)) {
      return observed("schema_invalid", text, "Parsed JSON failed the decision schema");
    }
    if (META.test(diagnostic)) {
      return observed("meta_validation_chatter", text, "Model discussed validation instead of research content");
    }
    return observed("json_invalid", text, "Output was not valid JSON");
  }
  if (SCHEMA.test(text)) {
    return observed("schema_invalid", text, "Parsed JSON failed the decision schema");
  }
  if (META.test(text)) {
    return observed("meta_validation_chatter", text, "Model discussed validation instead of research content");
  }
  if (REPETITION.test(text) || reason === "repetitive") {
    return {
      failureClass: "repetition",
      symptom: truncate(text),
      rootCause: null,
      provisional: true,
      confidence: "observed",
      source: "runtime",
      evidence:
        "Repeated dialogue content is an observed quality symptom. It is not automatically a verified reasoning deficiency or training signal.",
    };
  }
  if (MATH.test(text)) {
    return {
      failureClass: "math_unverified",
      symptom: truncate(text),
      rootCause: null,
      provisional: true,
      confidence: "observed",
      source: "runtime",
      evidence: "Math claim lacked independent verification in-transcript. Not a verified capability failure.",
    };
  }
  if (EVIDENCE.test(text)) {
    return observed("unsupported_evidence", text, "Claim lacked supported evidence references");
  }
  if (CONTEXT.test(text)) {
    return observed("context_missing", text, "Required conversation context was unavailable");
  }
  if (ORCH.test(text)) {
    return observed("orchestration_failure", text, "Conversation orchestration failed before usable model output");
  }
  return {
    failureClass: "unknown",
    symptom: truncate(text || "unclassified"),
    rootCause: null,
    provisional: true,
    confidence: "provisional",
    source: "runtime",
    evidence: "No stronger symptom class matched. Remains provisional.",
  };
}

function observed(failureClass: FailureClass, text: string, symptom: string): FailureClassification {
  return {
    failureClass,
    symptom: truncate(symptom),
    rootCause: null,
    provisional: true,
    confidence: "observed",
    source: "runtime",
    evidence: truncate(text),
  };
}

function truncate(value: string, max = 480): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
