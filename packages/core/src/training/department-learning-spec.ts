import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * C1.8B typed department learning experiment specification.
 * Versioned, department-agnostic, and intentionally non-executing.
 */
export const DEPARTMENT_LEARNING_SPEC_VERSION = "c18b-department-learning-v1" as const;

export const LEARNING_EXPERIMENT_STATUSES = [
  "proposed",
  "validated",
  "rejected",
  "awaiting_approval",
  "approved",
  // Execution statuses are reserved for later milestones; this foundation never reaches them.
  "queued",
  "running",
  "evaluated",
  "failed",
  "cancelled",
] as const;

export type LearningExperimentStatus = (typeof LEARNING_EXPERIMENT_STATUSES)[number];

export const LEARNING_DEPARTMENT_SLUGS = [
  "math",
  "science",
  "reasoning",
  "research",
  "product",
  "engineering",
  "evaluation",
  "weight-optimization",
  "memory-and-forgetting",
  "orchestration",
  "monitoring",
  "ceo",
  "evolution",
] as const;

export type LearningDepartmentSlug = (typeof LEARNING_DEPARTMENT_SLUGS)[number];

/** Which department owns which learning responsibility in C1.8B. */
export const LEARNING_ROLE_DEPARTMENTS = {
  weaknessRequester: null as LearningDepartmentSlug | null, // any target department may request for itself
  trainingMethodProposer: "weight-optimization" as const,
  provenanceReviewer: "memory-and-forgetting" as const,
  codeImplementer: "engineering" as const,
  independentEvaluator: "evaluation" as const,
} as const;

const slugSchema = z.enum(LEARNING_DEPARTMENT_SLUGS);

const datasetRefSchema = z.object({
  datasetId: z.string().trim().min(1).max(128),
  contentHash: z.string().trim().regex(/^[a-f0-9]{64}$/i, "dataset contentHash must be sha256 hex"),
  source: z.string().trim().min(1).max(200),
  provenanceNote: z.string().trim().min(1).max(500),
  trainItemIds: z.array(z.string().trim().min(1).max(128)).max(10_000),
  sealedEvaluationItemIds: z.array(z.string().trim().min(1).max(128)).max(10_000),
});

const trainingConfigSchema = z.object({
  methodId: z.string().trim().min(1).max(64),
  learningRate: z.number().finite().positive(),
  steps: z.number().int().min(0).max(200),
  datasetSize: z.number().int().positive().max(100_000),
  rank: z.number().int().positive().max(256).optional(),
  seed: z.number().int().nonnegative(),
  target: z.enum(["answer", "structured"]),
  backend: z.enum(["mlx-lm", "cuda-lora", "unspecified"]),
});

const codePatchFileSchema = z.object({
  path: z.string().trim().min(1).max(240),
  action: z.enum(["modify", "add", "delete"]),
  unifiedDiff: z.string().min(1).max(200_000),
});

export const trainingCodePatchSchema = z.object({
  baseRevision: z.string().trim().min(1).max(128),
  /** Content fingerprint of the proposed patch set (computed or supplied). */
  modifiedRevision: z.string().trim().min(1).max(128),
  rationale: z.string().trim().min(12).max(2_000),
  expectedBenefit: z.string().trim().min(12).max(2_000),
  files: z.array(codePatchFileSchema).min(1).max(20),
  proposedByDepartmentSlug: slugSchema,
});

const budgetSchema = z.object({
  maxGpuHours: z.number().finite().nonnegative().max(168),
  maxMemoryBytes: z.number().int().positive().max(96 * 1024 ** 3),
  maxWallClockMinutes: z.number().int().positive().max(24 * 60),
  maxExperiments: z.number().int().positive().max(100),
});

const evaluationPlanSchema = z.object({
  suiteId: z.string().trim().min(1).max(128),
  suiteVersion: z.string().trim().min(1).max(64),
  successCriteria: z.string().trim().min(12).max(2_000),
  regressionChecks: z.array(z.string().trim().min(1).max(200)).max(32),
  independentEvaluatorDepartmentSlug: z.literal("evaluation"),
});

const approvalSchema = z.object({
  departmentSlug: slugSchema,
  principalId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  scope: z.enum(["validation", "promotion"]),
  at: z.string().datetime(),
});

export const departmentLearningExperimentSchema = z.object({
  specVersion: z.literal(DEPARTMENT_LEARNING_SPEC_VERSION),
  experimentId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(200),
  status: z.enum(LEARNING_EXPERIMENT_STATUSES),
  requestingDepartmentSlug: slugSchema,
  targetDepartmentSlug: slugSchema,
  proposingDepartmentSlug: slugSchema,
  proposedByPrincipalId: z.string().uuid(),
  learningObjective: z.string().trim().min(12).max(2_000),
  targetedSkills: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  baseModel: z.object({
    family: z.string().trim().min(1).max(64),
    alias: z.string().trim().min(1).max(128),
    registryModelId: z.string().uuid(),
    digest: z.string().trim().min(8).max(200),
    weightsVersion: z.string().trim().min(1).max(64),
  }),
  datasets: z.array(datasetRefSchema).min(1).max(8),
  training: trainingConfigSchema,
  codePatch: trainingCodePatchSchema.nullable(),
  budgets: budgetSchema,
  evaluation: evaluationPlanSchema,
  artifactRefs: z.array(z.string().trim().min(1).max(240)).max(32).default([]),
  approvals: z.array(approvalSchema).max(32).default([]),
  createdAt: z.string().datetime(),
});

export type DatasetRef = z.infer<typeof datasetRefSchema>;
export type TrainingCodePatch = z.infer<typeof trainingCodePatchSchema>;
export type DepartmentLearningExperiment = z.infer<typeof departmentLearningExperimentSchema>;

export function fingerprintLearningExperiment(experiment: DepartmentLearningExperiment): string {
  const canonical = canonicalize(experiment);
  return createHash("sha256").update(canonical).digest("hex");
}

export function fingerprintCodePatch(patch: TrainingCodePatch): string {
  return createHash("sha256").update(canonicalize(patch)).digest("hex");
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, child]) => [key, sortKeys(child)]));
  }
  return value;
}
