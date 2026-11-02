import { compareManifests, type ComparisonResult } from "./compare.js";
import type { EvaluationManifest } from "./manifest.js";
import { mcnemarExact, wilsonInterval, type Interval } from "./stats.js";

export type PairedVerdict =
  | "improvement"
  | "regression"
  | "inconclusive"
  | "noncomparable"
  | "insufficient_evidence"
  | "invalid_evaluation";

export interface AlignedItem {
  itemId: string;
  contentDigest: string;
  baselineCorrect: boolean | null;
  candidateCorrect: boolean | null;
  baselineValid: boolean;
  candidateValid: boolean;
}

export interface PairedAnalysis {
  verdict: PairedVerdict;
  comparison: ComparisonResult;
  sampleSize: number;
  validPairs: number;
  missingOrInvalidPairs: number;
  baselineCorrect: number;
  candidateCorrect: number;
  baselineAccuracy: number | null;
  candidateAccuracy: number | null;
  absoluteDifference: number | null;
  relativeDifference: number | null;
  improved: number;
  regressed: number;
  unchangedCorrect: number;
  unchangedIncorrect: number;
  pairedInterval: Interval | null;
  baselineInterval: Interval | null;
  candidateInterval: Interval | null;
  pValue: number | null;
  alpha: number;
  familySize: number;
  adjustedAlpha: number;
  deploymentAuthorization: "separate_decision_required";
  limitations: string;
}

const LIMITATION =
  "Exact McNemar uses jointly valid discordant pairs and treats items as independent. A non-significant result is not evidence of equivalence. The paired interval is a Wald interval. Statistical evidence does not authorize deployment.";

export function analyzePairedRuns(input: {
  baseline: EvaluationManifest;
  candidate: EvaluationManifest;
  items: readonly AlignedItem[];
  alpha?: number;
  familySize?: number;
  design?: { kind: "strict" } | { kind: "qualified"; acceptedConfounders: readonly string[] };
}): PairedAnalysis {
  const alpha = input.alpha ?? 0.05;
  const familySize = input.familySize ?? 1;
  const adjustedAlpha = alpha / familySize;
  const comparison = compareManifests(input.baseline, input.candidate, input.design ?? { kind: "strict" });
  const empty = blank(comparison, alpha, familySize, adjustedAlpha);
  if (!comparison.comparable) {
    return { ...empty, verdict: comparison.design === "indeterminate" ? "insufficient_evidence" : "noncomparable" };
  }
  const alignment = align(input.items);
  if (!alignment.ok) {
    return { ...empty, verdict: "invalid_evaluation", missingOrInvalidPairs: input.items.length };
  }
  const valid = alignment.items.filter((item) => item.baselineValid && item.candidateValid && item.baselineCorrect !== null && item.candidateCorrect !== null);
  const missingOrInvalidPairs = alignment.items.length - valid.length;
  if (valid.length === 0) {
    return { ...empty, verdict: "insufficient_evidence", sampleSize: alignment.items.length, missingOrInvalidPairs };
  }
  let improved = 0;
  let regressed = 0;
  let unchangedCorrect = 0;
  let unchangedIncorrect = 0;
  for (const item of valid) {
    if (item.baselineCorrect && item.candidateCorrect) {
      unchangedCorrect += 1;
    } else if (!item.baselineCorrect && !item.candidateCorrect) {
      unchangedIncorrect += 1;
    } else if (item.candidateCorrect) {
      improved += 1;
    } else {
      regressed += 1;
    }
  }
  const validPairs = valid.length;
  const baselineCorrect = unchangedCorrect + regressed;
  const candidateCorrect = unchangedCorrect + improved;
  const baselineAccuracy = baselineCorrect / validPairs;
  const candidateAccuracy = candidateCorrect / validPairs;
  const absoluteDifference = candidateAccuracy - baselineAccuracy;
  const relativeDifference = baselineAccuracy === 0 ? null : absoluteDifference / baselineAccuracy;
  const pValue = mcnemarExact(regressed, improved);
  const pairedInterval = waldInterval(improved, regressed, validPairs);
  const significant = pValue < adjustedAlpha && pairedInterval.low > 0;
  const significantDrop = pValue < adjustedAlpha && pairedInterval.high < 0;
  let verdict: PairedVerdict = "inconclusive";
  if (significant && absoluteDifference > 0) {
    verdict = "improvement";
  } else if (significantDrop && absoluteDifference < 0) {
    verdict = "regression";
  }
  return {
    ...empty,
    verdict,
    sampleSize: alignment.items.length,
    validPairs,
    missingOrInvalidPairs,
    baselineCorrect,
    candidateCorrect,
    baselineAccuracy,
    candidateAccuracy,
    absoluteDifference,
    relativeDifference,
    improved,
    regressed,
    unchangedCorrect,
    unchangedIncorrect,
    pairedInterval,
    baselineInterval: wilsonInterval(baselineCorrect, validPairs),
    candidateInterval: wilsonInterval(candidateCorrect, validPairs),
    pValue,
  };
}

function align(items: readonly AlignedItem[]): { ok: true; items: AlignedItem[] } | { ok: false } {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.itemId}\n${item.contentDigest}`;
    if (seen.has(item.itemId) || seen.has(key)) {
      return { ok: false };
    }
    seen.add(item.itemId);
    seen.add(key);
  }
  return { ok: true, items: [...items].sort((left, right) => (left.itemId < right.itemId ? -1 : 1)) };
}

function waldInterval(improved: number, regressed: number, sampleSize: number): Interval {
  const difference = (improved - regressed) / sampleSize;
  const variance = (improved + regressed - (improved - regressed) ** 2 / sampleSize) / sampleSize ** 2;
  const margin = 1.96 * Math.sqrt(Math.max(0, variance));
  return { low: difference - margin, high: difference + margin };
}

function blank(comparison: ComparisonResult, alpha: number, familySize: number, adjustedAlpha: number): PairedAnalysis {
  return {
    verdict: "inconclusive",
    comparison,
    sampleSize: 0,
    validPairs: 0,
    missingOrInvalidPairs: 0,
    baselineCorrect: 0,
    candidateCorrect: 0,
    baselineAccuracy: null,
    candidateAccuracy: null,
    absoluteDifference: null,
    relativeDifference: null,
    improved: 0,
    regressed: 0,
    unchangedCorrect: 0,
    unchangedIncorrect: 0,
    pairedInterval: null,
    baselineInterval: null,
    candidateInterval: null,
    pValue: null,
    alpha,
    familySize,
    adjustedAlpha,
    deploymentAuthorization: "separate_decision_required",
    limitations: LIMITATION,
  };
}
