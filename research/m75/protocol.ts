/** Frozen before confirmatory evaluation. Development calibration may only choose the task cell. */

export const EXPERIMENT_ID = "m75-phase1";
export const GENERATOR_VERSION = "arith-m75-v1";
export const SCORER_VERSION = "answer-extract-m75-v1";
export const RESEARCH_PROFILE = "qwen3-1.7b-arith-m75";
export const REQUESTED_MODEL_ID = "Qwen/Qwen3-1.7B-MLX-4bit";
export const PRIMARY_REVISION = "21457c6f51ed54a7c16e988c0844db973815c137";
export const FALLBACK_MODEL_ID = "mlx-community/Qwen3-0.6B-4bit";

export const PROMPT_PREFIX =
  "Compute the value of the expression. Reply with the integer result only.\nExpression: ";

export const THINKING_MODE = "closed-empty-prefill";

export const EVAL_DECODING = {
  temperature: 0,
  topP: 1,
  maxTokens: 32,
  thinking: THINKING_MODE,
} as const;

export const SAMPLE_DECODING = {
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 32,
  thinking: THINKING_MODE,
} as const;

export const TRAIN_BUDGET = {
  maxSteps: 200,
  maxRank: 16,
  maxSequenceLength: 512,
  maxBatchSize: 2,
  maxLayers: 28,
  minVerifiedExamples: 16,
  maxExamples: 128,
  maxAnswerRepetition: 8,
  maxEasyShare: 0.6,
} as const;

/** One pre-registered configuration. Development data does not retune these values. */
export const TRAIN_CONFIG = {
  rank: 8,
  scale: 2,
  dropout: 0,
  learningRate: 0.0001,
  batchSize: 1,
  gradAccum: 1,
  maxSeq: 192,
  steps: 80,
  numLayers: 8,
  targetModules: ["q_proj", "v_proj"] as const,
  optimizer: "adamw",
} as const;

export const SPLIT_COUNTS = {
  calibrationPerCell: 16,
  devEval: 48,
  sealed: 300,
  ood: 80,
  validation: 24,
  experience: 48,
  supervisedPool: 128,
  samplesPerProblem: 3,
  retentionDev: 16,
  retentionConfirm: 16,
} as const;

export const TRAINING_SEEDS = [101, 202, 303] as const;
export const MAX_SELF_ROUNDS = 3;
export const DEV_GAIN_TO_CONTINUE = 0.02;
export const RETENTION_DROP_TOLERANCE = 0.15;
export const RESEARCH_MIN_SAMPLE = 100;
export const RESEARCH_ALPHA = 0.05;
/** Two conditions times three confirmatory seeds. */
export const BONFERRONI_TESTS = 6;

export interface TaskCell {
  id: string;
  termCount: number;
  operandMin: number;
  operandMax: number;
  operators: Array<"+" | "-" | "*">;
}

export const CALIBRATION_CELLS: TaskCell[] = [
  { id: "add2-20", termCount: 2, operandMin: 1, operandMax: 20, operators: ["+"] },
  { id: "as2-50", termCount: 2, operandMin: 1, operandMax: 50, operators: ["+", "-"] },
  { id: "as3-30", termCount: 3, operandMin: 1, operandMax: 30, operators: ["+", "-"] },
  { id: "as3-99", termCount: 3, operandMin: 1, operandMax: 99, operators: ["+", "-"] },
  { id: "as4-50", termCount: 4, operandMin: 1, operandMax: 50, operators: ["+", "-"] },
  { id: "as4-200", termCount: 4, operandMin: 10, operandMax: 200, operators: ["+", "-"] },
  { id: "asm3-12", termCount: 3, operandMin: 2, operandMax: 12, operators: ["+", "-", "*"] },
  { id: "asm4-20", termCount: 4, operandMin: 2, operandMax: 20, operators: ["+", "-", "*"] },
];

/** Used only when the first ladder misses the 30–60% band. These sit between the observed cliff. */
export const INTERMEDIATE_CELLS: TaskCell[] = [
  { id: "as4-20", termCount: 4, operandMin: 1, operandMax: 20, operators: ["+", "-"] },
  { id: "asm3-30", termCount: 3, operandMin: 2, operandMax: 30, operators: ["+", "-", "*"] },
  { id: "as4-30", termCount: 4, operandMin: 2, operandMax: 30, operators: ["+", "-"] },
];

export const HARDER_CELLS: TaskCell[] = [
  { id: "as4-999", termCount: 4, operandMin: 50, operandMax: 999, operators: ["+", "-"] },
  { id: "asm4-40", termCount: 4, operandMin: 2, operandMax: 40, operators: ["+", "-", "*"] },
  { id: "asm5-15", termCount: 5, operandMin: 2, operandMax: 15, operators: ["+", "-", "*"] },
];

export const EASIER_CELLS: TaskCell[] = [
  { id: "add2-9", termCount: 2, operandMin: 1, operandMax: 9, operators: ["+"] },
  { id: "as2-9", termCount: 2, operandMin: 1, operandMax: 9, operators: ["+", "-"] },
];

export const SPLIT_SEEDS = {
  experience: 11001,
  supervised: 11002,
  validation: 11003,
  development: 11004,
  sealed: 11005,
  ood: 11006,
} as const;
