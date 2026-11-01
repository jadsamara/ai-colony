import { z } from "zod";
import { AGENT_STATUSES, ROLE_NAMES, SPECIFICATION_VERSION } from "../constants.js";
import { parameterBudgetSchema, resourceBudgetSchema } from "./budget.js";
import {
  capabilitySchema,
  memoryNamespaceSchema,
  pageSchema,
  paginationQuerySchema,
  performanceMetricsSchema,
  uuidSchema,
} from "./common.js";

export const agentStatusSchema = z.enum(AGENT_STATUSES);
export const roleNameSchema = z.enum(ROLE_NAMES);

export const agentSchema = z.object({
  id: uuidSchema,
  departmentId: uuidSchema,
  name: z.string().min(1).max(120),
  role: roleNameSchema,
  description: z.string().min(1).max(4000),
  capabilities: capabilitySchema,
  modelId: uuidSchema.nullable(),
  adapterVersion: z.string().min(1).max(64).nullable(),
  memoryNamespace: memoryNamespaceSchema,
  permissions: z.array(z.string()),
  computeBudget: resourceBudgetSchema,
  parameterBudget: parameterBudgetSchema,
  status: agentStatusSchema,
  performanceMetrics: performanceMetricsSchema,
  parentAgentId: uuidSchema.nullable(),
  principalId: uuidSchema,
  specificationVersion: z.literal(SPECIFICATION_VERSION),
  runtimeOwner: z.string().nullable(),
  runtimeHeartbeatAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const agentCreateSchema = z
  .object({
    departmentId: uuidSchema,
    name: z.string().trim().min(1).max(120),
    role: roleNameSchema,
    description: z.string().trim().min(1).max(4000),
    capabilities: capabilitySchema.optional(),
    modelId: uuidSchema.nullable().optional(),
    adapterVersion: z.string().trim().min(1).max(64).nullable().optional(),
    memoryNamespace: memoryNamespaceSchema.optional(),
    computeBudget: resourceBudgetSchema,
    parameterBudget: parameterBudgetSchema,
    performanceMetrics: performanceMetricsSchema.optional(),
    parentAgentId: uuidSchema.nullable().optional(),
  })
  .strict();

export const agentUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    capabilities: capabilitySchema.optional(),
    modelId: uuidSchema.nullable().optional(),
    adapterVersion: z.string().trim().min(1).max(64).nullable().optional(),
    memoryNamespace: memoryNamespaceSchema.optional(),
    performanceMetrics: performanceMetricsSchema.optional(),
    parentAgentId: uuidSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export const agentRoleChangeSchema = z
  .object({
    role: roleNameSchema,
  })
  .strict();

export const agentListQuerySchema = paginationQuerySchema.extend({
  departmentId: uuidSchema.optional(),
  status: agentStatusSchema.optional(),
});

export const executorAttachSchema = z
  .object({
    kind: z.literal("lifecycle-only"),
  })
  .strict();

export const executorCapabilitySchema = z.object({
  kind: z.literal("lifecycle-only"),
  inference: z.literal(false),
  learning: z.literal(false),
  training: z.literal(false),
  description: z.string(),
});

export const agentRuntimeViewSchema = z.object({
  agentId: uuidSchema,
  status: agentStatusSchema,
  runtimeOwner: z.string().nullable(),
  runtimeHeartbeatAt: z.string().datetime().nullable(),
  ownedByThisProcess: z.boolean(),
  staleRuntime: z.boolean(),
  localExecution: z.object({
    attached: z.boolean(),
    activelyExecuting: z.boolean(),
    executor: executorCapabilitySchema.nullable(),
  }),
});

export const agentFailSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const agentRetrySchema = z
  .object({
    authorizeRetry: z.literal(true),
  })
  .strict();

export const lifecycleEventSchema = z.object({
  id: uuidSchema,
  agentId: uuidSchema,
  fromStatus: agentStatusSchema,
  toStatus: agentStatusSchema,
  reason: z.string(),
  actorId: z.string(),
  actorType: z.string(),
  correlationId: z.string(),
  createdAt: z.string().datetime(),
});

export const agentResponseSchema = z.object({
  agent: agentSchema,
  runtime: agentRuntimeViewSchema,
});

export const agentListResponseSchema = pageSchema(agentSchema);
export const agentStatusResponseSchema = z.object({ runtime: agentRuntimeViewSchema });
export const lifecycleEventListResponseSchema = pageSchema(lifecycleEventSchema);
export const executorAttachResponseSchema = z.object({
  runtime: agentRuntimeViewSchema,
});

export type Agent = z.infer<typeof agentSchema>;
export type AgentCreate = z.infer<typeof agentCreateSchema>;
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;
export type AgentRuntimeView = z.infer<typeof agentRuntimeViewSchema>;
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;
export type ExecutorCapabilityReport = z.infer<typeof executorCapabilitySchema>;
export type RoleName = z.infer<typeof roleNameSchema>;
