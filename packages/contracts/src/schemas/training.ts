import { z } from "zod";
import { CANDIDATE_STATUSES, TRAINING_PROFILE_ID, TRAINING_RUN_STATUSES } from "../constants.js";
import { uuidSchema } from "./common.js";

export const trainingRunStatusSchema = z.enum(TRAINING_RUN_STATUSES);
export const candidateStatusSchema = z.enum(CANDIDATE_STATUSES);
export const trainingProfileSchema = z.literal(TRAINING_PROFILE_ID);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z.string().datetime();

export const trainingConfigSchema = z
  .object({
    profile: trainingProfileSchema,
    family: z.literal("gemma-3"),
    parameterCount: z.literal(270_000_000),
    framework: z.literal("mlx-lm"),
    rank: z.number().int().positive(),
    alpha: z.number().positive(),
    scale: z.number().positive(),
    dropout: z.number().nonnegative(),
    targetModules: z.array(z.string()).min(1),
    learningRate: z.number().positive(),
    batchSize: z.number().int().positive(),
    gradAccum: z.number().int().positive(),
    maxSeq: z.number().int().positive(),
    steps: z.number().int().positive(),
    numLayers: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
    datasetHash: sha256Schema,
    baseSha256: sha256Schema,
  })
  .strict();

export const acceptanceCriteriaSchema = z
  .object({
    metric: z.literal("numeric_correctness"),
    requireStrictImprovement: z.literal(true),
    minStructuredValidity: z.literal(1),
    ignoreTrainingLoss: z.literal(true),
  })
  .strict();

export const trainableCheckpointRegisterSchema = z
  .object({
    registryModelId: uuidSchema,
    checkpointPath: z.string().min(1).max(1024),
    expectedSha256: sha256Schema,
    source: z.string().trim().min(1).max(300),
    revision: z.string().trim().min(1).max(200),
    tokenizerId: z.string().trim().min(1).max(200),
    precision: z.enum(["bf16", "fp16", "int4"]),
    architecture: z.enum(["gemma3_text", "gemma3"]),
    framework: z.literal("mlx-lm"),
    frameworkVersion: z.string().trim().min(1).max(40),
    license: z.string().trim().min(1).max(200),
    contextLength: z.number().int().positive().max(32768),
  })
  .strict();

export const trainingDatasetCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    taskDomain: z.literal("structured-arithmetic"),
    seed: z.number().int().min(0).max(2_147_483_647).default(7),
    source: z.enum(["curated_arithmetic", "supplied", "memories", "objective_traces"]),
    exampleCount: z.number().int().min(24).max(128).optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/).optional(),
    examples: z
      .array(
        z
          .object({
            input: z.string().trim().min(1).max(500),
            sourceObjectiveId: uuidSchema.optional(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    memoryIds: z.array(uuidSchema).max(128).optional(),
  })
  .strict();

export const trainingRunCreateSchema = z
  .object({
    trainableModelId: uuidSchema,
    datasetVersionId: uuidSchema,
    profile: trainingProfileSchema,
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
  })
  .strict();

export const trainingReproduceSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
  })
  .strict();

export const trainingDecisionSchema = z
  .object({
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const trainingEvaluateSchema = z
  .object({
    decoding: z.literal("greedy").default("greedy"),
  })
  .strict();

export const promotionRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const experimentalInferenceSchema = z
  .object({
    candidateId: uuidSchema,
    prompt: z.string().trim().min(1).max(200),
  })
  .strict();

export const trainableCheckpointSchema = z.object({
  id: uuidSchema,
  registryModelId: uuidSchema,
  displayName: z.string(),
  modelFamily: z.string(),
  source: z.string(),
  revision: z.string(),
  parameterCount: z.number().int().positive(),
  precision: z.string(),
  architecture: z.string(),
  tokenizerId: z.string(),
  contextLength: z.number().int().positive(),
  framework: z.string(),
  frameworkVersion: z.string(),
  relativePath: z.string(),
  sha256: sha256Schema,
  license: z.string(),
  availableLocally: z.boolean(),
  eligibleForTraining: z.boolean(),
  servingReady: z.boolean(),
  createdAt: isoSchema,
});

export const trainingExampleSchema = z.object({
  id: uuidSchema,
  split: z.enum(["train", "validation", "test"]),
  groupKey: z.string(),
  source: z.string(),
  license: z.string(),
  input: z.string(),
  expectedOutput: z.string(),
  validationStatus: z.literal("verified"),
  sourceMemoryId: uuidSchema.nullable(),
  sourceObjectiveId: uuidSchema.nullable(),
  contentHash: sha256Schema,
});

export const trainingDatasetSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  taskDomain: z.string(),
  versionId: uuidSchema,
  version: z.number().int().positive(),
  contentHash: sha256Schema,
  splitSeed: z.number().int(),
  status: z.literal("sealed"),
  trainCount: z.number().int().nonnegative(),
  validationCount: z.number().int().nonnegative(),
  testCount: z.number().int().nonnegative(),
  criteria: acceptanceCriteriaSchema,
  rejected: z.array(z.object({ input: z.string(), reason: z.string() })),
  examples: z.array(trainingExampleSchema),
  createdAt: isoSchema,
});

export const trainingRunSchema = z.object({
  id: uuidSchema,
  datasetVersionId: uuidSchema,
  trainableModelId: uuidSchema,
  parentRunId: uuidSchema.nullable(),
  profile: trainingProfileSchema,
  status: trainingRunStatusSchema,
  seed: z.number().int(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  config: trainingConfigSchema,
  approvedBy: z.string().nullable(),
  approvedAt: isoSchema.nullable(),
  startedAt: isoSchema.nullable(),
  finishedAt: isoSchema.nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  createdBy: z.string(),
  createdAt: isoSchema,
});

export const trainingMetricSchema = z.object({
  step: z.number().int().nonnegative(),
  trainLoss: z.number().nullable(),
  validationLoss: z.number().nullable(),
  learningRate: z.number().nullable(),
  recordedAt: isoSchema,
});

export const trainingArtifactSchema = z.object({
  id: uuidSchema,
  runId: uuidSchema,
  kind: z.enum(["adapter", "checkpoint"]),
  relativePath: z.string(),
  sha256: sha256Schema,
  byteSize: z.number().int().positive(),
  format: z.enum(["safetensors", "float32-bin"]),
  trainableParameters: z.number().int().nonnegative(),
  createdAt: isoSchema,
});

export const scoreSchema = z.object({
  exactMatch: z.number(),
  numericCorrectness: z.number(),
  structuredValidity: z.number(),
  errorRate: z.number(),
  meanOutputLength: z.number(),
  latencyMs: z.number().int().nonnegative(),
  variability: z.number(),
});

export const candidateSchema = z.object({
  id: uuidSchema,
  runId: uuidSchema,
  adapterId: uuidSchema,
  status: candidateStatusSchema,
  baseModelId: uuidSchema,
  baseFamily: z.string(),
  adapterSha256: sha256Schema,
  trainableParameters: z.number().int().positive(),
  createdAt: isoSchema,
});

export const evaluationSchema = z.object({
  id: uuidSchema,
  candidateId: uuidSchema,
  runId: uuidSchema,
  acceptanceMet: z.boolean(),
  criteria: acceptanceCriteriaSchema,
  baseline: scoreSchema,
  candidate: scoreSchema,
  report: z.record(z.unknown()),
  createdAt: isoSchema,
});

export const registryResponseSchema = z.object({
  productionModelId: uuidSchema,
  note: z.string(),
  models: z.array(
    z.object({
      id: uuidSchema,
      displayName: z.string(),
      modelFamily: z.string(),
      status: z.string(),
      artifactUri: z.string().nullable(),
      trainableFlag: z.boolean(),
    }),
  ),
  checkpoints: z.array(trainableCheckpointSchema),
});

export const experimentalInferenceResponseSchema = z.object({
  output: z.string(),
  baseModelId: uuidSchema,
  baseFamily: z.string(),
  adapterId: uuidSchema,
  adapterSha256: sha256Schema,
  framework: z.enum(["scripted", "mlx"]),
  loadedAdapter: z.literal(true),
  decoding: z.literal("greedy"),
  productionModelId: uuidSchema,
  usedProductionModel: z.literal(false),
});

export const trainingHealthSchema = z.object({
  provider: z.enum(["scripted", "mlx"]),
  ready: z.boolean(),
  productionModelId: uuidSchema,
  productionIsolated: z.literal(true),
  detail: z.string(),
});

export const trainingSummarySchema = z.object({
  queued: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  datasets: z.number().int().nonnegative(),
  examples: z.number().int().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
  candidatesApproved: z.number().int().nonnegative(),
  candidatesRejected: z.number().int().nonnegative(),
});

export type TrainingDatasetCreate = z.infer<typeof trainingDatasetCreateSchema>;
export type TrainingRunCreate = z.infer<typeof trainingRunCreateSchema>;
export type TrainableCheckpointRegister = z.infer<typeof trainableCheckpointRegisterSchema>;
export type TrainingConfig = z.infer<typeof trainingConfigSchema>;
export type AcceptanceCriteria = z.infer<typeof acceptanceCriteriaSchema>;
export type TrainingRunStatus = z.infer<typeof trainingRunStatusSchema>;
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;
