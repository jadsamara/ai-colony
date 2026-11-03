import { analyzePairedRuns, type AlignedItem, type PairedVerdict } from "../evaluation/paired.js";
import { parseEvaluationManifest, type EvaluationManifest } from "../evaluation/manifest.js";
import type { Interval } from "../evaluation/stats.js";
import { newcombePairedDifference } from "./interval.js";
import type { LedgerMapping, LedgerSnapshot, MeasurementMode } from "./types.js";

export interface LedgerComparison {
  verdict: PairedVerdict;
  contractVerdict: PairedVerdict;
  rawPValue: number | null;
  adjustedPValue: number | null;
  interval: Interval | null;
  intervalMethod: "newcombe-1998-method-10" | null;
  waldInterval: Interval | null;
  absoluteDifference: number | null;
  sampleSize: number;
  validPairs: number;
  reasons: string[];
  attribution: {
    cause: "not_attributed" | "contrast_named_adapter_change";
    catastrophicForgetting: false;
    note: string;
  };
  deploymentAuthorization: "separate_decision_required";
}

const NOT_A_CAUSE =
  "A matched decline is regression evidence on a previously measured capability. It does not establish that a weight update was the cause.";

export function compareCertifiedSnapshots(input: {
  baseline: LedgerSnapshot;
  candidate: LedgerSnapshot;
  baselineMappings: readonly LedgerMapping[];
  candidateMappings: readonly LedgerMapping[];
  commonItemDesign?: boolean;
  attributeAdapterContrast?: boolean;
  alpha?: number;
}): LedgerComparison {
  const reasons: string[] = [];
  const blocked = (verdict: PairedVerdict, reason: string): LedgerComparison => ({
    verdict,
    contractVerdict: verdict,
    rawPValue: null,
    adjustedPValue: null,
    interval: null,
    intervalMethod: null,
    waldInterval: null,
    absoluteDifference: null,
    sampleSize: 0,
    validPairs: 0,
    reasons: [reason],
    attribution: { cause: "not_attributed", catastrophicForgetting: false, note: NOT_A_CAUSE },
    deploymentAuthorization: "separate_decision_required",
  });
  if (input.baseline.validity !== "valid" || input.candidate.validity !== "valid") {
    return blocked("invalid_evaluation", "Both snapshots must be valid measurements");
  }
  if (input.baseline.topicId !== input.candidate.topicId) {
    return blocked("noncomparable", "Snapshots of different topics are not a matched capability");
  }
  if (input.baseline.measurementMode !== input.candidate.measurementMode || input.baseline.capabilityKind !== input.candidate.capabilityKind) {
    return blocked("noncomparable", "Measurement mode and capability kind must match");
  }
  const sameMapping = input.baseline.mappingVersionId === input.candidate.mappingVersionId;
  if (!sameMapping && input.commonItemDesign !== true) {
    return blocked("noncomparable", "The benchmark mapping changed and no common-item design was recorded");
  }
  let baselineManifest: EvaluationManifest;
  let candidateManifest: EvaluationManifest;
  try {
    baselineManifest = parseEvaluationManifest(input.baseline.manifest);
    candidateManifest = parseEvaluationManifest(input.candidate.manifest);
  } catch {
    return blocked("invalid_evaluation", "Stored evaluation evidence is not a valid manifest");
  }
  if (!itemsMatchMapping(input.baseline, input.baselineMappings, reasons) || !itemsMatchMapping(input.candidate, input.candidateMappings, reasons)) {
    return blocked("invalid_evaluation", reasons[0] ?? "Snapshot items are not covered by the approved mapping");
  }
  const alignment = alignSnapshots(input.baseline, input.candidate, input.commonItemDesign === true);
  if (!alignment.ok) {
    return blocked(alignment.verdict, alignment.reason);
  }
  const analysis = analyzePairedRuns({
    baseline: baselineManifest,
    candidate: candidateManifest,
    items: alignment.items,
    alpha: input.alpha ?? 0.05,
    familySize: 1,
  });
  if (analysis.verdict === "noncomparable" || analysis.verdict === "insufficient_evidence" || analysis.verdict === "invalid_evaluation") {
    return {
      verdict: analysis.verdict,
      contractVerdict: analysis.verdict,
      rawPValue: analysis.pValue,
      adjustedPValue: analysis.pValue,
      interval: null,
      intervalMethod: null,
      waldInterval: analysis.pairedInterval,
      absoluteDifference: analysis.absoluteDifference,
      sampleSize: analysis.sampleSize,
      validPairs: analysis.validPairs,
      reasons: analysis.comparison.reasons,
      attribution: { cause: "not_attributed", catastrophicForgetting: false, note: NOT_A_CAUSE },
      deploymentAuthorization: "separate_decision_required",
    };
  }
  const interval = newcombePairedDifference({
    bothCorrect: analysis.unchangedCorrect,
    baselineOnly: analysis.regressed,
    candidateOnly: analysis.improved,
    neitherCorrect: analysis.unchangedIncorrect,
  });
  const pValue = analysis.pValue ?? 1;
  const alpha = input.alpha ?? 0.05;
  const difference = analysis.absoluteDifference ?? 0;
  let verdict: PairedVerdict = "inconclusive";
  if (pValue < alpha && interval.low > 0 && difference > 0) {
    verdict = "improvement";
  } else if (pValue < alpha && interval.high < 0 && difference < 0) {
    verdict = "regression";
  }
  const adapterContrast =
    input.attributeAdapterContrast === true &&
    analysis.comparison.comparable &&
    analysis.comparison.confounders.length === 0 &&
    analysis.comparison.allowedDifferences.some((path) => path.startsWith("model.adapter"));
  return {
    verdict,
    contractVerdict: analysis.verdict,
    rawPValue: pValue,
    adjustedPValue: pValue,
    interval,
    intervalMethod: "newcombe-1998-method-10",
    waldInterval: analysis.pairedInterval,
    absoluteDifference: analysis.absoluteDifference,
    sampleSize: analysis.sampleSize,
    validPairs: analysis.validPairs,
    reasons: analysis.comparison.reasons,
    attribution: adapterContrast
      ? {
          cause: "contrast_named_adapter_change",
          catastrophicForgetting: false,
          note: "The comparison was explicitly designed as an adapter contrast. The ledger does not certify that the adapter caused the change.",
        }
      : { cause: "not_attributed", catastrophicForgetting: false, note: NOT_A_CAUSE },
    deploymentAuthorization: "separate_decision_required",
  };
}

function itemsMatchMapping(snapshot: LedgerSnapshot, mappings: readonly LedgerMapping[], reasons: string[]): boolean {
  const covered = new Map(mappings.filter((row) => row.topicId === snapshot.topicId).map((row) => [row.itemId, row.contentDigest]));
  if (snapshot.items.length === 0) {
    reasons.push("A capability snapshot needs the benchmark items that support it");
    return false;
  }
  for (const item of snapshot.items) {
    const digest = covered.get(item.itemId);
    if (!digest || digest !== item.contentDigest) {
      reasons.push("A snapshot item is missing from the approved mapping or its content digest changed");
      return false;
    }
  }
  return true;
}

function alignSnapshots(
  baseline: LedgerSnapshot,
  candidate: LedgerSnapshot,
  commonItemDesign: boolean,
): { ok: true; items: AlignedItem[] } | { ok: false; verdict: PairedVerdict; reason: string } {
  const left = new Map(baseline.items.map((item) => [item.itemId, item]));
  const right = new Map(candidate.items.map((item) => [item.itemId, item]));
  if (left.size !== baseline.items.length || right.size !== candidate.items.length) {
    return { ok: false, verdict: "invalid_evaluation", reason: "A snapshot repeats a benchmark item" };
  }
  const sameKeys = left.size === right.size && [...left.keys()].every((id) => right.has(id));
  if (!sameKeys && !commonItemDesign) {
    return { ok: false, verdict: "noncomparable", reason: "Benchmark items are not aligned" };
  }
  const ids = sameKeys ? [...left.keys()] : [...left.keys()].filter((id) => right.has(id));
  if (ids.length === 0) {
    return { ok: false, verdict: "insufficient_evidence", reason: "The snapshots share no benchmark items" };
  }
  const items: AlignedItem[] = [];
  for (const id of ids) {
    const base = left.get(id);
    const next = right.get(id);
    if (!base || !next || base.contentDigest !== next.contentDigest) {
      return { ok: false, verdict: "noncomparable", reason: "A shared item changed content digest" };
    }
    items.push({
      itemId: id,
      contentDigest: base.contentDigest,
      baselineCorrect: base.correct,
      candidateCorrect: next.correct,
      baselineValid: base.valid && base.correct !== null,
      candidateValid: next.valid && next.correct !== null,
    });
  }
  return { ok: true, items };
}

export function measurementModeOf(manifest: EvaluationManifest): MeasurementMode | null {
  return manifest.generation.retrieval.state === "set" ? manifest.generation.retrieval.value : null;
}
