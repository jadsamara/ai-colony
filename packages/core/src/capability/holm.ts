import type { Interval } from "../evaluation/stats.js";
import type { PairedVerdict } from "../evaluation/paired.js";

export function holmAdjust(pValues: readonly (number | null)[]): (number | null)[] {
  const present = pValues
    .map((pValue, index) => ({ pValue, index }))
    .filter((row): row is { pValue: number; index: number } => row.pValue !== null && Number.isFinite(row.pValue));
  const sorted = [...present].sort((left, right) => left.pValue - right.pValue);
  const adjusted = pValues.map(() => null as number | null);
  let running = 0;
  const family = present.length;
  sorted.forEach((row, rank) => {
    const raw = Math.min(1, (family - rank) * row.pValue);
    running = Math.max(running, raw);
    adjusted[row.index] = running;
  });
  return adjusted;
}

export interface HolmRow {
  rawPValue: number | null;
  verdict: PairedVerdict;
  interval: Interval | null;
  absoluteDifference: number | null;
}

export function applyHolm<T extends HolmRow>(rows: readonly T[], alpha = 0.05): Array<T & { adjustedPValue: number | null }> {
  const adjusted = holmAdjust(rows.map((row) => row.rawPValue));
  return rows.map((row, index) => {
    const adjustedPValue = adjusted[index] ?? null;
    if (row.verdict === "noncomparable" || row.verdict === "invalid_evaluation" || row.verdict === "insufficient_evidence") {
      return { ...row, adjustedPValue };
    }
    if (adjustedPValue === null || row.interval === null || row.absoluteDifference === null) {
      return { ...row, adjustedPValue, verdict: "insufficient_evidence" as const };
    }
    const improvement = adjustedPValue < alpha && row.interval.low > 0 && row.absoluteDifference > 0;
    const regression = adjustedPValue < alpha && row.interval.high < 0 && row.absoluteDifference < 0;
    const verdict: PairedVerdict = improvement ? "improvement" : regression ? "regression" : "inconclusive";
    return { ...row, adjustedPValue, verdict };
  });
}
