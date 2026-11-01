import type { AcceptanceCriteria } from "@ai-colony/contracts";

export interface Score {
  exactMatch: number;
  numericCorrectness: number;
  structuredValidity: number;
  errorRate: number;
  meanOutputLength: number;
  latencyMs: number;
  variability: number;
}

const INTEGER = /^-?(0|[1-9]\d*)$/;

export function scoreOutputs(expected: string[], actual: string[], latencyMs: number, variability: number): Score {
  const total = expected.length;
  if (total === 0) {
    throw new Error("evaluation requires at least one held-out example");
  }
  let exact = 0;
  let numeric = 0;
  let structured = 0;
  let length = 0;
  for (let index = 0; index < total; index += 1) {
    const prediction = (actual[index] ?? "").trim();
    const target = expected[index] ?? "";
    length += prediction.length;
    if (INTEGER.test(prediction)) {
      structured += 1;
      if (Number(prediction) === Number(target)) {
        numeric += 1;
      }
    }
    if (prediction === target) {
      exact += 1;
    }
  }
  return {
    exactMatch: exact / total,
    numericCorrectness: numeric / total,
    structuredValidity: structured / total,
    errorRate: 1 - structured / total,
    meanOutputLength: length / total,
    latencyMs,
    variability,
  };
}

export function meetsAcceptance(baseline: Score, candidate: Score, criteria: AcceptanceCriteria): boolean {
  if (candidate.structuredValidity < criteria.minStructuredValidity) {
    return false;
  }
  if (criteria.requireStrictImprovement && candidate.numericCorrectness <= baseline.numericCorrectness) {
    return false;
  }
  return true;
}

export function variability(first: string[], second: string[]): number {
  if (first.length === 0) {
    return 0;
  }
  let changed = 0;
  for (let index = 0; index < first.length; index += 1) {
    if ((first[index] ?? "").trim() !== (second[index] ?? "").trim()) {
      changed += 1;
    }
  }
  return changed / first.length;
}
