import { z } from "zod";
import {
  OBJECTIVE_HARD_CAPS,
  OBJECTIVE_STATUSES,
  RUNTIME_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  TOKEN_SOURCES,
} from "../constants.js";
import { pageSchema, paginationQuerySchema, uuidSchema } from "./common.js";

export const objectiveStatusSchema = z.enum(OBJECTIVE_STATUSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskTypeSchema = z.enum(TASK_TYPES);
export const runtimeStatusSchema = z.enum(RUNTIME_STATUSES);
export const tokenSourceSchema = z.enum(TOKEN_SOURCES);

const boundedInt = (max: number) => z.number().int().positive().max(max);

export const objectiveLimitsSchema = z
  .object({
    maxInferenceRequests: boundedInt(OBJECTIVE_HARD_CAPS.maxInferenceRequests),
    maxOutputTokens: boundedInt(OBJECTIVE_HARD_CAPS.maxOutputTokens),
    maxEstimatedTokens: boundedInt(OBJECTIVE_HARD_CAPS.maxEstimatedTokens),
    maxTaskAttempts: boundedInt(OBJECTIVE_HARD_CAPS.maxTaskAttempts),
    maxConcurrentTasks: boundedInt(OBJECTIVE_HARD_CAPS.maxConcurrentTasks),
    maxDurationMs: boundedInt(OBJECTIVE_HARD_CAPS.maxDurationMs),
  })
  .strict();

export const objectiveCreateSchema = z
  .object({
    objective: z.string().trim().min(1).max(OBJECTIVE_HARD_CAPS.objectiveText),
    limits: objectiveLimitsSchema.partial().optional(),
  })
  .strict();

export const planTaskSchema = z
  .object({
    localId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    departmentSlug: taskTypeSchema,
    taskType: taskTypeSchema,
    objective: z.string().trim().min(1).max(4000),
    expectedOutput: z.string().trim().min(1).max(2000),
    dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(8),
  })
  .strict();

export const objectivePlanSchema = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    tasks: z.array(planTaskSchema).min(1).max(OBJECTIVE_HARD_CAPS.maxTasks),
    completionCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    estimatedResources: z
      .object({
        inferenceRequests: boundedInt(OBJECTIVE_HARD_CAPS.maxInferenceRequests),
        outputTokens: boundedInt(OBJECTIVE_HARD_CAPS.maxOutputTokens),
      })
      .strict(),
    risks: z.array(z.string().trim().min(1).max(500)).max(8),
  })
  .strict();

export const objectiveSchema = z.object({
  id: uuidSchema,
  submitterPrincipalId: uuidSchema,
  objective: z.string(),
  status: objectiveStatusSchema,
  correlationId: uuidSchema,
  failureReason: z.string().nullable(),
  finalOutput: z.string().nullable(),
  executionAuthorized: z.boolean(),
  planCorrections: z.number().int().nonnegative(),
  limits: objectiveLimitsSchema,
  consumedRequests: z.number().int().nonnegative(),
  consumedOutputTokens: z.number().int().nonnegative(),
  estimatedOutputTokens: z.number().int().nonnegative(),
  estimatedCostUsdMicros: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const objectiveTaskSchema = z.object({
  id: uuidSchema,
  objectiveId: uuidSchema,
  localId: z.string(),
  departmentId: uuidSchema,
  departmentSlug: taskTypeSchema,
  taskType: taskTypeSchema,
  objective: z.string(),
  expectedOutput: z.string(),
  dependsOn: z.array(uuidSchema),
  status: taskStatusSchema,
  attempt: z.number().int().positive(),
  assignedAgentId: uuidSchema.nullable(),
  requestMessageId: uuidSchema.nullable(),
  error: z.string().nullable(),
  resultSummary: z.string().nullable(),
  deadline: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const workflowEventSchema = z.object({
  id: uuidSchema,
  objectiveId: uuidSchema.nullable(),
  eventType: z.string(),
  summary: z.string(),
  createdAt: z.string().datetime(),
});

export const runtimeModelSchema = z.object({
  modelId: uuidSchema,
  displayName: z.string(),
  registryStatus: z.string(),
  runtimeStatus: runtimeStatusSchema,
  expectedAlias: z.string().nullable(),
  loadedModelId: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  probedAt: z.string().datetime().nullable(),
});

export const inferenceHealthSchema = z.object({
  models: z.array(runtimeModelSchema),
  memoryProfile: z.enum(["shared", "split"]),
  concurrency: z.number().int().positive(),
});

export const monitoringOverviewSchema = z.object({
  objectives: z.record(objectiveStatusSchema, z.number().int().nonnegative()),
  tasks: z.record(taskStatusSchema, z.number().int().nonnegative()),
  outboxPending: z.number().int().nonnegative(),
  deadLettersOpen: z.number().int().nonnegative(),
  workers: z.array(
    z.object({
      workerId: z.string(),
      role: z.string(),
      beatAt: z.string().datetime(),
      stale: z.boolean(),
    }),
  ),
  models: z.array(runtimeModelSchema),
  inference: z.object({
    requests: z.number().int().nonnegative(),
    observedOutputTokens: z.number().int().nonnegative(),
    estimatedOutputTokens: z.number().int().nonnegative(),
    unavailableUsage: z.number().int().nonnegative(),
    estimatedCostUsdMicros: z.number().int().nonnegative().nullable(),
  }),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
      summary: z.string(),
    }),
  ),
});

export const objectiveResponseSchema = z.object({ objective: objectiveSchema });
export const objectiveListResponseSchema = pageSchema(objectiveSchema);
export const objectiveTaskListResponseSchema = z.object({ tasks: z.array(objectiveTaskSchema) });
export const workflowEventListResponseSchema = pageSchema(workflowEventSchema);
export const objectiveListQuerySchema = paginationQuerySchema.extend({
  status: objectiveStatusSchema.optional(),
});
export const objectiveCancelResponseSchema = objectiveResponseSchema;

export type ObjectiveStatus = z.infer<typeof objectiveStatusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type ObjectiveLimits = z.infer<typeof objectiveLimitsSchema>;
export type ObjectiveCreate = z.infer<typeof objectiveCreateSchema>;
export type ObjectivePlan = z.infer<typeof objectivePlanSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
export type ObjectiveRecord = z.infer<typeof objectiveSchema>;
export type ObjectiveTask = z.infer<typeof objectiveTaskSchema>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type InferenceHealth = z.infer<typeof inferenceHealthSchema>;
export type MonitoringOverview = z.infer<typeof monitoringOverviewSchema>;
