export type TruncationStatus = "confirmed" | "suspected" | "none" | "indeterminate";

export interface ItemEvidence {
  taskCorrect: boolean | null;
  formatValid: boolean | null;
  extractionOk: boolean | null;
  termination: "stop" | "length" | "error" | "timeout" | "unknown" | "omitted";
  generationError: boolean;
  toolOrRetrievalFailure: boolean;
  scorerFailure: boolean;
  evidenceComplete: boolean;
  truncationEvidence: "confirmed" | "suspected" | "none" | "absent";
}

export interface ItemClassification {
  taskCorrectness: "correct" | "incorrect" | "unknown";
  outputValidity: "valid" | "invalid_format" | "extraction_failure" | "unknown";
  executionValidity: "valid" | "generation_error" | "timeout" | "tool_or_retrieval_failure" | "scorer_failure" | "incomplete";
  truncation: TruncationStatus;
}

export interface EvaluationMetrics {
  attempted: number;
  validlyEvaluated: number;
  correct: number;
  incorrect: number;
  formatFailures: number;
  extractionFailures: number;
  confirmedTruncations: number;
  suspectedTruncations: number;
  infrastructureFailures: number;
  coverage: number;
  endToEndSuccessRate: number | null;
  conditionalAccuracy: number | null;
  endToEndDenominator: number;
  conditionalDenominator: number;
}

export function classifyItem(evidence: ItemEvidence): ItemClassification {
  const truncation = truncationStatus(evidence);
  if (!evidence.evidenceComplete) {
    return { taskCorrectness: "unknown", outputValidity: "unknown", executionValidity: "incomplete", truncation };
  }
  if (evidence.scorerFailure) {
    return { taskCorrectness: "unknown", outputValidity: "unknown", executionValidity: "scorer_failure", truncation };
  }
  if (evidence.generationError || evidence.termination === "error") {
    return { taskCorrectness: "unknown", outputValidity: "unknown", executionValidity: "generation_error", truncation };
  }
  if (evidence.termination === "timeout") {
    return { taskCorrectness: "unknown", outputValidity: "unknown", executionValidity: "timeout", truncation };
  }
  if (evidence.toolOrRetrievalFailure) {
    return { taskCorrectness: "unknown", outputValidity: "unknown", executionValidity: "tool_or_retrieval_failure", truncation };
  }
  if (evidence.extractionOk === false) {
    return { taskCorrectness: "unknown", outputValidity: "extraction_failure", executionValidity: "valid", truncation };
  }
  if (evidence.formatValid === false) {
    return { taskCorrectness: "unknown", outputValidity: "invalid_format", executionValidity: "valid", truncation };
  }
  if (evidence.formatValid === null || evidence.extractionOk === null || evidence.taskCorrect === null) {
    return { taskCorrectness: "unknown", outputValidity: "unknown", executionValidity: "incomplete", truncation };
  }
  return {
    taskCorrectness: evidence.taskCorrect ? "correct" : "incorrect",
    outputValidity: "valid",
    executionValidity: "valid",
    truncation,
  };
}

export function summarizeItems(items: readonly ItemClassification[]): EvaluationMetrics {
  const attempted = items.length;
  let validlyEvaluated = 0;
  let correct = 0;
  let incorrect = 0;
  let formatFailures = 0;
  let extractionFailures = 0;
  let confirmedTruncations = 0;
  let suspectedTruncations = 0;
  let infrastructureFailures = 0;
  let endToEndSuccesses = 0;
  for (const item of items) {
    if (item.truncation === "confirmed") {
      confirmedTruncations += 1;
    }
    if (item.truncation === "suspected") {
      suspectedTruncations += 1;
    }
    if (item.outputValidity === "invalid_format") {
      formatFailures += 1;
    }
    if (item.outputValidity === "extraction_failure") {
      extractionFailures += 1;
    }
    if (item.executionValidity !== "valid") {
      infrastructureFailures += 1;
    }
    const valid = item.executionValidity === "valid" && item.outputValidity === "valid" && item.taskCorrectness !== "unknown";
    if (valid) {
      validlyEvaluated += 1;
      if (item.taskCorrectness === "correct") {
        correct += 1;
      }
      if (item.taskCorrectness === "incorrect") {
        incorrect += 1;
      }
    }
    if (item.executionValidity === "valid" && item.taskCorrectness === "correct" && item.outputValidity === "valid") {
      endToEndSuccesses += 1;
    }
  }
  return {
    attempted,
    validlyEvaluated,
    correct,
    incorrect,
    formatFailures,
    extractionFailures,
    confirmedTruncations,
    suspectedTruncations,
    infrastructureFailures,
    coverage: attempted === 0 ? 0 : validlyEvaluated / attempted,
    endToEndSuccessRate: attempted === 0 ? null : endToEndSuccesses / attempted,
    conditionalAccuracy: validlyEvaluated === 0 ? null : correct / validlyEvaluated,
    endToEndDenominator: attempted,
    conditionalDenominator: validlyEvaluated,
  };
}

function truncationStatus(evidence: ItemEvidence): TruncationStatus {
  if (evidence.termination === "length" || evidence.truncationEvidence === "confirmed") {
    return "confirmed";
  }
  if (evidence.truncationEvidence === "suspected") {
    return "suspected";
  }
  if (evidence.termination === "stop" || evidence.truncationEvidence === "none") {
    return "none";
  }
  return "indeterminate";
}
