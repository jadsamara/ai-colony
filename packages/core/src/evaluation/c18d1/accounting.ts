/** Conservative evaluation accounting carried forward from Phase 0 v3. */

export interface C18d1OutcomeCounts {
  correct: number;
  wrong: number;
  invalid: number;
  truncated: number;
}

export function summarizeC18d1Counts(input: C18d1OutcomeCounts): {
  sampleSize: number;
  observedAccuracy: number;
  lowerBoundAccuracy: number;
  upperBoundAccuracy: number;
  countsConsistent: boolean;
} & C18d1OutcomeCounts {
  const sampleSize = input.correct + input.wrong + input.invalid + input.truncated;
  return {
    ...input,
    sampleSize,
    observedAccuracy: sampleSize ? input.correct / sampleSize : 0,
    lowerBoundAccuracy: sampleSize ? input.correct / sampleSize : 0,
    upperBoundAccuracy: sampleSize ? (input.correct + input.invalid + input.truncated) / sampleSize : 0,
    countsConsistent: sampleSize === input.correct + input.wrong + input.invalid + input.truncated,
  };
}

export function conservativeImprovement(base: C18d1OutcomeCounts, adapter: C18d1OutcomeCounts): {
  baseUpperBoundAccuracy: number;
  adapterLowerBoundAccuracy: number;
  conservativeImprovement: number;
  observedImprovement: number;
} {
  const b = summarizeC18d1Counts(base);
  const a = summarizeC18d1Counts(adapter);
  return {
    baseUpperBoundAccuracy: b.upperBoundAccuracy,
    adapterLowerBoundAccuracy: a.lowerBoundAccuracy,
    conservativeImprovement: a.lowerBoundAccuracy - b.upperBoundAccuracy,
    observedImprovement: a.observedAccuracy - b.observedAccuracy,
  };
}
