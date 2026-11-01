export interface Interval {
  low: number;
  high: number;
}

export interface PairedCounts {
  sampleSize: number;
  bothCorrect: number;
  baselineOnly: number;
  candidateOnly: number;
  neitherCorrect: number;
  baselineAccuracy: number;
  candidateAccuracy: number;
  difference: number;
}

/** Wilson score interval for a binomial proportion. z defaults to 1.96. */
export function wilsonInterval(successes: number, sampleSize: number, z = 1.96): Interval {
  if (sampleSize <= 0) {
    return { low: 0, high: 1 };
  }
  const proportion = successes / sampleSize;
  const z2 = z * z;
  const denominator = 1 + z2 / sampleSize;
  const center = (proportion + z2 / (2 * sampleSize)) / denominator;
  const margin = (z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * sampleSize)) / sampleSize)) / denominator;
  return { low: clamp(center - margin), high: clamp(center + margin) };
}

export function pairedCounts(baselineCorrect: boolean[], candidateCorrect: boolean[]): PairedCounts {
  if (baselineCorrect.length !== candidateCorrect.length || baselineCorrect.length === 0) {
    throw new Error("paired comparison requires equal non-empty outcome lists");
  }
  let bothCorrect = 0;
  let baselineOnly = 0;
  let candidateOnly = 0;
  let neitherCorrect = 0;
  for (let index = 0; index < baselineCorrect.length; index += 1) {
    const baseline = baselineCorrect[index] === true;
    const candidate = candidateCorrect[index] === true;
    if (baseline && candidate) {
      bothCorrect += 1;
    } else if (baseline) {
      baselineOnly += 1;
    } else if (candidate) {
      candidateOnly += 1;
    } else {
      neitherCorrect += 1;
    }
  }
  const sampleSize = baselineCorrect.length;
  return {
    sampleSize,
    bothCorrect,
    baselineOnly,
    candidateOnly,
    neitherCorrect,
    baselineAccuracy: (bothCorrect + baselineOnly) / sampleSize,
    candidateAccuracy: (bothCorrect + candidateOnly) / sampleSize,
    difference: (candidateOnly - baselineOnly) / sampleSize,
  };
}

/**
 * Exact two-sided McNemar p-value from the discordant pairs.
 * A sample below the promotion minimum must not be described as significant.
 */
export function mcnemarExact(baselineOnly: number, candidateOnly: number): number {
  const discordant = baselineOnly + candidateOnly;
  if (discordant === 0) {
    return 1;
  }
  const smaller = Math.min(baselineOnly, candidateOnly);
  let tail = 0;
  for (let index = 0; index <= smaller; index += 1) {
    tail += binomial(discordant, index);
  }
  return Math.min(1, (2 * tail) / 2 ** discordant);
}

export function claimSignificance(sampleSize: number, minimumSample: number, pValue: number): boolean {
  return sampleSize >= minimumSample && pValue < 0.05;
}

function binomial(n: number, k: number): number {
  let value = 1;
  for (let index = 1; index <= k; index += 1) {
    value = (value * (n - k + index)) / index;
  }
  return value;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
