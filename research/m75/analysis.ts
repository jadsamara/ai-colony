import type { TaskCell } from "./protocol.js";
import { BONFERRONI_TESTS, FALLBACK_MODEL_ID, REQUESTED_MODEL_ID, RESEARCH_ALPHA, RESEARCH_MIN_SAMPLE, RETENTION_DROP_TOLERANCE, TRAIN_BUDGET, TRAIN_CONFIG } from "./protocol.js";

export type ResearchConclusion = "POSITIVE_EVIDENCE" | "NEGATIVE_EVIDENCE" | "INCONCLUSIVE" | "RETENTION_FAILURE" | "EVALUATION_INVALID";

export interface CellMeasurement {
  id: string;
  accuracy: number;
  sampleSize: number;
}

export function assertResearchModel(modelId: string): void {
  if (modelId !== REQUESTED_MODEL_ID && modelId !== FALLBACK_MODEL_ID) {
    throw new Error(`research model ${modelId} is not allowlisted`);
  }
}

export function assertTrainBudget(config: { steps: number; rank: number; maxSeq: number; batchSize: number; numLayers: number }): void {
  if (config.steps > TRAIN_BUDGET.maxSteps || config.rank > TRAIN_BUDGET.maxRank || config.maxSeq > TRAIN_BUDGET.maxSequenceLength || config.batchSize > TRAIN_BUDGET.maxBatchSize || config.numLayers > TRAIN_BUDGET.maxLayers) {
    throw new Error("training configuration exceeds the local budget");
  }
  if (config.steps < 1 || config.rank < 1 || config.batchSize < 1 || config.numLayers < 1) {
    throw new Error("training configuration is incomplete");
  }
}

export function frozenTrainConfig(): typeof TRAIN_CONFIG {
  assertTrainBudget(TRAIN_CONFIG);
  return TRAIN_CONFIG;
}

export function extensionDirection(measurements: CellMeasurement[]): "harder" | "easier" | null {
  if (measurements.length === 0) {
    return null;
  }
  if (measurements.every((item) => item.accuracy > 0.85)) {
    return "harder";
  }
  if (measurements.every((item) => item.accuracy < 0.15)) {
    return "easier";
  }
  return null;
}

export function combinatorialSpace(cell: TaskCell): number {
  return (cell.operandMax - cell.operandMin + 1) ** cell.termCount * cell.operators.length ** (cell.termCount - 1);
}

export function selectCalibrationCell(measurements: CellMeasurement[], cells: TaskCell[] = []): { id: string; inBand: boolean; bandMissed: boolean } {
  if (measurements.length === 0) {
    throw new Error("calibration produced no measurements");
  }
  const space = new Map(cells.map((cell) => [cell.id, combinatorialSpace(cell)]));
  const inBand = measurements.filter((item) => item.accuracy >= 0.3 && item.accuracy <= 0.6 && item.sampleSize > 0);
  const pool = inBand.length > 0 ? inBand : measurements.filter((item) => item.sampleSize > 0);
  const closest = Math.min(...pool.map((item) => Math.abs(item.accuracy - 0.45)));
  const ranked = [...pool].sort((left, right) => {
    const leftNear = Math.abs(Math.abs(left.accuracy - 0.45) - closest) <= 0.05 ? 0 : 1;
    const rightNear = Math.abs(Math.abs(right.accuracy - 0.45) - closest) <= 0.05 ? 0 : 1;
    if (leftNear !== rightNear) {
      return leftNear - rightNear;
    }
    const spaceGap = (space.get(right.id) ?? 0) - (space.get(left.id) ?? 0);
    if (spaceGap !== 0) {
      return spaceGap;
    }
    return Math.abs(left.accuracy - 0.45) - Math.abs(right.accuracy - 0.45);
  });
  const selected = ranked[0];
  if (selected === undefined) {
    throw new Error("calibration measurements were empty");
  }
  return { id: selected.id, inBand: inBand.length > 0, bandMissed: inBand.length === 0 };
}

export function allocationFor(cell: TaskCell): {
  sealed: number;
  experience: number;
  supervisedPool: number;
  devEval: number;
  ood: number;
  validation: number;
  samplesPerProblem: number;
  note: string;
} {
  const space = combinatorialSpace(cell);
  if (space >= 2500) {
    return {
      sealed: 300,
      experience: 144,
      supervisedPool: 128,
      devEval: 48,
      ood: 80,
      validation: 24,
      samplesPerProblem: 3,
      note: `Combinatorial space ${space} supports the pre-registered 300-item holdout.`,
    };
  }
  if (space >= 900) {
    return {
      sealed: 200,
      experience: 72,
      supervisedPool: 80,
      devEval: 32,
      ood: 40,
      validation: 16,
      samplesPerProblem: 3,
      note: `Combinatorial space ${space} cannot hold 300 sealed items and the other disjoint splits. The sealed count is 200.`,
    };
  }
  return {
    sealed: 100,
    experience: 36,
    supervisedPool: 48,
    devEval: 24,
    ood: 24,
    validation: 12,
    samplesPerProblem: 2,
    note: `Combinatorial space ${space} is small. The sealed count is 100, the minimum used for a research significance claim.`,
  };
}

export function findCell(cells: TaskCell[], id: string): TaskCell {
  const cell = cells.find((item) => item.id === id);
  if (cell === undefined) {
    throw new Error(`unknown task cell ${id}`);
  }
  return cell;
}

export function concludeResearch(input: {
  valid: boolean;
  retentionFailed: boolean;
  difference: number;
  pValue: number | null;
  sampleSize: number;
}): ResearchConclusion {
  if (!input.valid || input.pValue === null || !Number.isFinite(input.pValue)) {
    return "EVALUATION_INVALID";
  }
  if (input.retentionFailed) {
    return "RETENTION_FAILURE";
  }
  if (input.sampleSize < RESEARCH_MIN_SAMPLE) {
    return "INCONCLUSIVE";
  }
  const significant = input.pValue < RESEARCH_ALPHA;
  if (input.difference > 0 && significant) {
    return "POSITIVE_EVIDENCE";
  }
  if (input.difference < 0 && significant) {
    return "NEGATIVE_EVIDENCE";
  }
  return "INCONCLUSIVE";
}

export function survivesBonferroni(pValue: number): boolean {
  return pValue < RESEARCH_ALPHA / BONFERRONI_TESTS;
}

export function retentionFailed(baseline: number, candidate: number, tolerance = RETENTION_DROP_TOLERANCE): boolean {
  return candidate + 1e-12 < baseline - tolerance;
}

export function continueSelfTraining(input: { round: number; devGain: number; retentionOk: boolean; verifiedExamples: number }): { continue: boolean; reason: string } {
  if (input.round >= 3) {
    return { continue: false, reason: "the three-round limit was reached" };
  }
  if (input.verifiedExamples < TRAIN_BUDGET.minVerifiedExamples) {
    return { continue: false, reason: "verified examples were below the minimum" };
  }
  if (!input.retentionOk) {
    return { continue: false, reason: "development retention dropped by more than the tolerance" };
  }
  if (input.devGain < 0.02) {
    return { continue: false, reason: "development accuracy did not improve by the continuation threshold" };
  }
  return { continue: true, reason: "development accuracy improved and retention stayed within tolerance" };
}

/** Phase 1 never promotes an adapter, including when research evidence is positive. */
export function phase1Decision(conclusion: ResearchConclusion): { promoted: false; deployment: "ineligible"; conclusion: ResearchConclusion; reason: string } {
  return {
    promoted: false,
    deployment: "ineligible",
    conclusion,
    reason: "Phase 1 records research evidence and does not promote or assign an adapter.",
  };
}

export function nextPhase(done: { probe: boolean; frozen: boolean; splits: boolean; trained: boolean; sealed: boolean }): string {
  if (!done.probe) {
    return "probe";
  }
  if (!done.frozen) {
    return "calibrate";
  }
  if (!done.splits) {
    return "splits";
  }
  if (!done.trained) {
    return "train";
  }
  if (!done.sealed) {
    return "sealed-evaluation";
  }
  return "report";
}

export function recoverTraining(result: { cancelled?: boolean; artifactPath?: string | null; retries: number }): { status: "cancelled" | "failed" | "completed"; retry: boolean; duplicateAdapter: false } {
  if (result.cancelled) {
    return { status: "cancelled", retry: false, duplicateAdapter: false };
  }
  if (!result.artifactPath) {
    return { status: "failed", retry: result.retries < 1, duplicateAdapter: false };
  }
  return { status: "completed", retry: false, duplicateAdapter: false };
}
