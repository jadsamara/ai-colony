import { wilsonInterval, type Interval } from "../evaluation/stats.js";

/** Two-sided 95% standard-normal quantile. Newcombe's published limits use this value, not 1.96. */
export const NEWCOMBE_Z = 1.959963984540054;

export interface PairedOutcomeTable {
  bothCorrect: number;
  baselineOnly: number;
  candidateOnly: number;
  neitherCorrect: number;
}

/**
 * Wilson interval for the share of improvements among discordant pairs, scaled back
 * by the discordant fraction. This describes that conditional share. It is not a
 * confidence interval for the paired accuracy difference (candidate minus baseline).
 */
export function discordantPairWilsonInterval(improved: number, regressed: number, sampleSize: number): Interval {
  if (sampleSize <= 0) {
    return { low: 0, high: 0 };
  }
  const discordant = improved + regressed;
  if (discordant === 0) {
    return { low: 0, high: 0 };
  }
  const wilson = wilsonInterval(improved, discordant);
  const scale = discordant / sampleSize;
  return {
    low: (2 * wilson.low - 1) * scale,
    high: (2 * wilson.high - 1) * scale,
  };
}

/**
 * Newcombe's method 10 interval for the paired accuracy difference
 * (candidate accuracy minus baseline accuracy).
 *
 * Wilson score limits for the two marginal proportions are combined with the
 * continuity-corrected phi coefficient. Phi is zero when any marginal count is
 * zero. The result is clipped to [-1, 1]. A negative radicand from floating-point
 * error is treated as zero.
 *
 * Newcombe RG. Improved confidence intervals for the difference between binomial
 * proportions based on paired data. Statistics in Medicine. 1998;17:2635-2650.
 */
export function newcombePairedDifference(table: PairedOutcomeTable, z = NEWCOMBE_Z): Interval {
  const bothCorrect = table.bothCorrect;
  const baselineOnly = table.baselineOnly;
  const candidateOnly = table.candidateOnly;
  const neitherCorrect = table.neitherCorrect;
  const counts = [bothCorrect, baselineOnly, candidateOnly, neitherCorrect];
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
    return { low: 0, high: 0 };
  }
  const sampleSize = bothCorrect + baselineOnly + candidateOnly + neitherCorrect;
  if (sampleSize <= 0 || !Number.isFinite(z) || z <= 0) {
    return { low: 0, high: 0 };
  }
  const baselineAccuracy = (bothCorrect + baselineOnly) / sampleSize;
  const candidateAccuracy = (bothCorrect + candidateOnly) / sampleSize;
  const difference = candidateAccuracy - baselineAccuracy;
  const baseline = wilsonInterval(bothCorrect + baselineOnly, sampleSize, z);
  const candidate = wilsonInterval(bothCorrect + candidateOnly, sampleSize, z);
  const phi = correctedPhi(bothCorrect, candidateOnly, baselineOnly, neitherCorrect, sampleSize);
  const lowerWidth = Math.sqrt(
    Math.max(
      0,
      (candidateAccuracy - candidate.low) ** 2 -
        2 * phi * (candidateAccuracy - candidate.low) * (baseline.high - baselineAccuracy) +
        (baseline.high - baselineAccuracy) ** 2,
    ),
  );
  const upperWidth = Math.sqrt(
    Math.max(
      0,
      (candidate.high - candidateAccuracy) ** 2 -
        2 * phi * (candidate.high - candidateAccuracy) * (baselineAccuracy - baseline.low) +
        (baselineAccuracy - baseline.low) ** 2,
    ),
  );
  return {
    low: clip(difference - lowerWidth),
    high: clip(difference + upperWidth),
  };
}

function correctedPhi(bothCorrect: number, firstOnly: number, secondOnly: number, neitherCorrect: number, sampleSize: number): number {
  const margins =
    (bothCorrect + firstOnly) * (secondOnly + neitherCorrect) * (bothCorrect + secondOnly) * (firstOnly + neitherCorrect);
  if (margins === 0) {
    return 0;
  }
  let numerator = bothCorrect * neitherCorrect - firstOnly * secondOnly;
  if (numerator > 0) {
    numerator = Math.max(numerator - sampleSize / 2, 0);
  }
  return numerator / Math.sqrt(margins);
}

function clip(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}
