export interface Interval {
  low: number;
  high: number;
}

export interface PairedComparison {
  sampleSize: number;
  bothCorrect: number;
  baselineOnly: number;
  candidateOnly: number;
  neitherCorrect: number;
  baselineAccuracy: number;
  candidateAccuracy: number;
  difference: number;
  pValue: number;
  differenceInterval: Interval;
}

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

export function pairedComparison(baselineCorrect: boolean[], candidateCorrect: boolean[]): PairedComparison {
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
  const difference = (candidateOnly - baselineOnly) / sampleSize;
  const discordant = baselineOnly + candidateOnly;
  const variance = (discordant - (candidateOnly - baselineOnly) ** 2 / sampleSize) / sampleSize ** 2;
  const margin = 1.96 * Math.sqrt(Math.max(0, variance));
  return {
    sampleSize,
    bothCorrect,
    baselineOnly,
    candidateOnly,
    neitherCorrect,
    baselineAccuracy: (bothCorrect + baselineOnly) / sampleSize,
    candidateAccuracy: (bothCorrect + candidateOnly) / sampleSize,
    difference,
    pValue: mcnemarExact(baselineOnly, candidateOnly),
    differenceInterval: { low: difference - margin, high: difference + margin },
  };
}

/** Two-sided exact McNemar p-value, summed in log space so large discordant counts stay finite. */
export function mcnemarExact(baselineOnly: number, candidateOnly: number): number {
  const discordant = baselineOnly + candidateOnly;
  if (!Number.isInteger(baselineOnly) || !Number.isInteger(candidateOnly) || baselineOnly < 0 || candidateOnly < 0) {
    throw new Error("McNemar counts must be non-negative integers");
  }
  if (discordant === 0) {
    return 1;
  }
  const smaller = Math.min(baselineOnly, candidateOnly);
  let logSum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index <= smaller; index += 1) {
    logSum = logAdd(logSum, logBinom(discordant, index) - discordant * Math.LN2);
  }
  return Math.min(1, 2 * Math.exp(logSum));
}

function logBinom(n: number, k: number): number {
  let value = 0;
  for (let index = 1; index <= k; index += 1) {
    value += Math.log(n - k + index) - Math.log(index);
  }
  return value;
}

function logAdd(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) {
    return right;
  }
  if (right === Number.NEGATIVE_INFINITY) {
    return left;
  }
  const max = Math.max(left, right);
  return max + Math.log(Math.exp(left - max) + Math.exp(right - max));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
