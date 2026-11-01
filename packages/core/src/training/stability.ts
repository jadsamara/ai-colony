import { DomainError } from "../errors/domain-error.js";

export const SEVERE_REGRESSION = 0.15;
export const DEFAULT_MAX_MEMORY_BYTES = 18_000_000_000;
export const DEFAULT_MAX_STEPS = 200;

export function meanExposures(steps: number, datasetSize: number, batchSize = 1): number {
  if (!Number.isInteger(steps) || steps < 0 || !Number.isInteger(datasetSize) || datasetSize < 1 || batchSize < 1) {
    throw new DomainError("INVALID_DATASET", "Exposure requires a non-negative step count and a positive dataset", 422);
  }
  return (steps * batchSize) / datasetSize;
}

export function stopDecision(input: {
  baselineAccuracy: number | null;
  candidateAccuracy: number | null;
  peakMemoryBytes: number | null;
  maxMemoryBytes?: number;
  steps: number;
  maxSteps?: number;
  lossFinite: boolean;
  datasetValid: boolean;
  modelCompatible: boolean;
  evaluationPresent: boolean;
}): { stop: boolean; reason: string | null } {
  const maxMemory = input.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!input.modelCompatible) {
    return { stop: true, reason: "The model is incompatible with this training method." };
  }
  if (!input.datasetValid) {
    return { stop: true, reason: "The dataset is invalid or overlaps a sealed split." };
  }
  if (!input.lossFinite) {
    return { stop: true, reason: "Training loss is not finite." };
  }
  if (input.steps > maxSteps) {
    return { stop: true, reason: "The step budget is exhausted." };
  }
  if (input.peakMemoryBytes !== null && input.peakMemoryBytes > maxMemory) {
    return { stop: true, reason: "Training memory exceeded the local budget." };
  }
  if (!input.evaluationPresent) {
    return { stop: true, reason: "Evaluation evidence is missing, so the configuration cannot continue." };
  }
  if (input.baselineAccuracy !== null && input.candidateAccuracy !== null && input.candidateAccuracy < input.baselineAccuracy - SEVERE_REGRESSION) {
    return { stop: true, reason: "Development accuracy regressed beyond the stop tolerance." };
  }
  return { stop: false, reason: null };
}

export function outputDisagreement(baseline: string[], candidate: string[]): { compared: number; changed: number } {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new DomainError("EVALUATION_FAILED", "The zero-update control requires paired outputs", 422);
  }
  let changed = 0;
  for (let index = 0; index < baseline.length; index += 1) {
    if (baseline[index] !== candidate[index]) {
      changed += 1;
    }
  }
  return { compared: baseline.length, changed };
}
