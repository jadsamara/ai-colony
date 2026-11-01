import { TRAINING_PROFILE_ID, type TrainingConfig } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";

export const TRAINING_BUDGETS = {
  maxSteps: 200,
  maxEpochs: 1,
  maxExamples: 128,
  maxSequenceLength: 256,
  maxRuntimeMs: 20 * 60 * 1000,
  maxConcurrentJobs: 1,
  maxArtifactBytes: 200_000_000,
  maxRetries: 1,
  maxRank: 16,
} as const;

const PROFILE = {
  profile: TRAINING_PROFILE_ID,
  family: "gemma-3",
  parameterCount: 270_000_000,
  framework: "mlx-lm",
  rank: 8,
  alpha: 16,
  scale: 2,
  dropout: 0,
  targetModules: ["q_proj", "v_proj"],
  learningRate: 0.0001,
  batchSize: 1,
  gradAccum: 1,
  maxSeq: 256,
  steps: 40,
  numLayers: 4,
} as const;

export function frozenConfig(seed: number, datasetHash: string, baseSha256: string): TrainingConfig {
  assertBudget();
  return { ...PROFILE, targetModules: [...PROFILE.targetModules], seed, datasetHash, baseSha256 };
}

function assertBudget(): void {
  if (
    PROFILE.steps > TRAINING_BUDGETS.maxSteps ||
    PROFILE.maxSeq > TRAINING_BUDGETS.maxSequenceLength ||
    PROFILE.rank > TRAINING_BUDGETS.maxRank ||
    PROFILE.batchSize > 2
  ) {
    throw new DomainError("BUDGET_EXCEEDED", "The allowlisted profile exceeds the local training budget", 422);
  }
}
