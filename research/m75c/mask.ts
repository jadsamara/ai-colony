/** Mask math for the installed MLX-LM 0.32.2 trainer.

`lengths` rows are `[promptOffset, tokenCount]`. Target step `s` predicts the token at
index `s` in the padded batch. The installed upper bound is inclusive, so step
`tokenCount` predicts the first padding cell whenever the padded width is longer
than the sequence.
*/

export interface MaskAudit {
  steps: number[];
  installed: boolean[];
  corrected: boolean[];
  installedCount: number;
  correctedCount: number;
  extraInstalledSteps: number[];
}

export function lossMasks(offset: number, tokenCount: number, targetWidth: number): MaskAudit {
  if (offset < 0 || tokenCount < offset || targetWidth < 1) {
    throw new Error("loss mask dimensions are invalid");
  }
  const steps: number[] = [];
  const installed: boolean[] = [];
  const corrected: boolean[] = [];
  for (let step = 1; step <= targetWidth; step += 1) {
    steps.push(step);
    installed.push(step >= offset && step <= tokenCount);
    corrected.push(step >= offset && step < tokenCount);
  }
  return {
    steps,
    installed,
    corrected,
    installedCount: installed.filter(Boolean).length,
    correctedCount: corrected.filter(Boolean).length,
    extraInstalledSteps: steps.filter((_, index) => installed[index] === true && corrected[index] !== true),
  };
}

/** Same padding width as `iterate_batches` in mlx-lm 0.32.2. */
export function paddedWidth(tokenCount: number, maxSeqLength: number, padTo = 32): number {
  const rounded = 1 + padTo * Math.floor((tokenCount + padTo - 1) / padTo);
  return Math.min(rounded, maxSeqLength);
}

export function targetTokenIndex(step: number): number {
  return step;
}
