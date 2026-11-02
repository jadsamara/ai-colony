import { wilsonInterval, type Interval } from "../evaluation/stats.js";

/**
 * Paired-difference interval from a Wilson score interval on the discordant pairs.
 * The difference is (2k - d) / n. The Wilson interval is scaled by d / n.
 * Concordant pairs contribute no width. This does not replace the Wald interval
 * used by analyzePairedRuns.
 */
export function pairedScoreInterval(improved: number, regressed: number, sampleSize: number): Interval {
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
