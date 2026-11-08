import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ParameterBudget, ResourceBudget } from "@ai-colony/contracts";

/** Measured length of embeddinggemma vectors from Ollama POST /api/embed. */
const EMBEDDING_DIMENSIONS = 768;
import {
  ACTOR_TYPES,
  AGENT_STATUSES,
  APPROVAL_STATUSES,
  APPROVAL_TARGET_TYPES,
  ADDRESSING_MODES,
  APPROVAL_TYPES,
  CREATION_SOURCES,
  DEAD_LETTER_STATUSES,
  DEPARTMENT_STATUSES,
  DEPARTMENT_TYPES,
  DEPLOYMENT_TARGETS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  INFERENCE_REQUEST_STATUSES,
  MODEL_STATUSES,
  OBJECTIVE_STATUSES,
  OUTBOX_STATUSES,
  PRINCIPAL_TYPES,
  PROCESSING_STATUSES,
  QUANTIZATIONS,
  ROLE_NAMES,
  SERVING_PROVIDERS,
  SERVING_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
} from "./constants.js";
import { textIn } from "./sql.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const roles = pgTable("roles", {
  name: text("name").primaryKey(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = pgTable("permissions", {
  name: text("name").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleName: text("role_name")
      .notNull()
      .references(() => roles.name, { onDelete: "restrict" }),
    permissionName: text("permission_name")
      .notNull()
      .references(() => permissions.name, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.roleName, table.permissionName] })],
);

export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey(),
    lineageId: uuid("lineage_id").notNull(),
    version: integer("version").notNull(),
    displayName: text("display_name").notNull(),
    modelFamily: text("model_family").notNull(),
    provider: text("provider").notNull(),
    parameterCount: bigint("parameter_count", { mode: "number" }).notNull(),
    modelType: text("model_type").notNull(),
    artifactUri: text("artifact_uri"),
    deploymentTarget: text("deployment_target").notNull(),
    status: text("status").notNull(),
    quantization: text("quantization"),
    contextWindow: integer("context_window"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull(),
    trainable: boolean("trainable").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("models_lineage_version_unique").on(table.lineageId, table.version),
    index("models_lineage_id_idx").on(table.lineageId),
    index("models_status_idx").on(table.status),
    index("models_created_at_id_idx").on(table.createdAt, table.id),
    check("models_status_check", textIn("status", MODEL_STATUSES)),
    check("models_deployment_target_check", textIn("deployment_target", DEPLOYMENT_TARGETS)),
    check(
      "models_quantization_check",
      sql`${table.quantization} is null or ${textIn("quantization", QUANTIZATIONS)}`,
    ),
    check("models_parameter_count_check", sql`${table.parameterCount} >= 0`),
    check("models_version_check", sql`${table.version} >= 1`),
    check(
      "models_context_window_check",
      sql`${table.contextWindow} is null or (${table.contextWindow} > 0 and ${table.contextWindow} <= 10000000)`,
    ),
  ],
);

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    purpose: text("purpose").notNull(),
    parentDepartmentId: uuid("parent_department_id").references((): AnyPgColumn => departments.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull(),
    departmentType: text("department_type").notNull(),
    creationSource: text("creation_source").notNull(),
    createdBy: text("created_by").notNull(),
    resourceBudget: jsonb("resource_budget").$type<ResourceBudget>().notNull(),
    policyRef: text("policy_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    specificationVersion: text("specification_version").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("departments_name_unique").on(table.name),
    unique("departments_slug_unique").on(table.slug),
    index("departments_parent_idx").on(table.parentDepartmentId),
    index("departments_status_idx").on(table.status),
    index("departments_created_at_id_idx").on(table.createdAt, table.id),
    check("departments_status_check", textIn("status", DEPARTMENT_STATUSES)),
    check("departments_type_check", textIn("department_type", DEPARTMENT_TYPES)),
    check("departments_creation_source_check", textIn("creation_source", CREATION_SOURCES)),
    check(
      "departments_parent_not_self",
      sql`${table.parentDepartmentId} is null or ${table.parentDepartmentId} <> ${table.id}`,
    ),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    roleName: text("role_name").notNull(),
    description: text("description").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull(),
    modelId: uuid("model_id").references(() => models.id, { onDelete: "restrict" }),
    adapterVersion: text("adapter_version"),
    memoryNamespace: text("memory_namespace").notNull(),
    computeBudget: jsonb("compute_budget").$type<ResourceBudget>().notNull(),
    parameterBudget: jsonb("parameter_budget").$type<ParameterBudget>().notNull(),
    status: text("status").notNull(),
    performanceMetrics: jsonb("performance_metrics").$type<Record<string, number>>().notNull(),
    parentAgentId: uuid("parent_agent_id").references((): AnyPgColumn => agents.id, {
      onDelete: "restrict",
    }),
    specificationVersion: text("specification_version").notNull(),
    runtimeOwner: text("runtime_owner"),
    runtimeHeartbeatAt: timestamp("runtime_heartbeat_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("agents_memory_namespace_unique").on(table.memoryNamespace),
    unique("agents_department_name_unique").on(table.departmentId, table.name),
    index("agents_department_id_idx").on(table.departmentId),
    index("agents_status_idx").on(table.status),
    index("agents_parent_agent_id_idx").on(table.parentAgentId),
    index("agents_runtime_status_idx").on(table.status, table.runtimeHeartbeatAt),
    index("agents_created_at_id_idx").on(table.createdAt, table.id),
    check("agents_status_check", textIn("status", AGENT_STATUSES)),
    check("agents_role_check", textIn("role_name", ROLE_NAMES)),
    check(
      "agents_parent_not_self",
      sql`${table.parentAgentId} is null or ${table.parentAgentId} <> ${table.id}`,
    ),
  ],
);

export const principals = pgTable(
  "principals",
  {
    id: uuid("id").primaryKey(),
    principalType: text("principal_type").notNull(),
    displayName: text("display_name").notNull(),
    roleName: text("role_name").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("principals_agent_id_unique").on(table.agentId),
    index("principals_role_name_idx").on(table.roleName),
    check("principals_type_check", textIn("principal_type", PRINCIPAL_TYPES)),
    check("principals_role_check", textIn("role_name", ROLE_NAMES)),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey(),
    approvalType: text("approval_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    decidedBy: uuid("decided_by").references(() => principals.id, { onDelete: "restrict" }),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("approval_requests_target_idx").on(table.targetType, table.targetId),
    index("approval_requests_status_idx").on(table.status),
    index("approval_requests_created_at_id_idx").on(table.createdAt, table.id),
    uniqueIndex("approval_requests_one_pending_idx")
      .on(table.approvalType, table.targetType, table.targetId)
      .where(sql`${table.status} = 'pending'`),
    check("approval_requests_type_check", textIn("approval_type", APPROVAL_TYPES)),
    check("approval_requests_target_type_check", textIn("target_type", APPROVAL_TARGET_TYPES)),
    check("approval_requests_status_check", textIn("status", APPROVAL_STATUSES)),
  ],
);

export const agentLifecycleEvents = pgTable(
  "agent_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    reason: text("reason").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_lifecycle_events_agent_idx").on(table.agentId, table.createdAt),
    check("agent_lifecycle_events_from_check", textIn("from_status", AGENT_STATUSES)),
    check("agent_lifecycle_events_to_check", textIn("to_status", AGENT_STATUSES)),
    check("agent_lifecycle_events_actor_check", textIn("actor_type", ACTOR_TYPES)),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    action: text("action").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    correlationId: text("correlation_id").notNull(),
    beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
    afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("audit_events_occurred_at_idx").on(table.occurredAt, table.eventId),
    index("audit_events_target_idx").on(table.targetType, table.targetId),
    index("audit_events_actor_idx").on(table.actorId),
    index("audit_events_correlation_idx").on(table.correlationId),
    check("audit_events_actor_type_check", textIn("actor_type", ACTOR_TYPES)),
  ],
);

export const iacpMessages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    protocolVersion: text("protocol_version").notNull(),
    messageType: text("message_type").notNull(),
    senderAgentId: uuid("sender_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    senderDepartmentId: uuid("sender_department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    recipientAgentId: uuid("recipient_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    recipientDepartmentId: uuid("recipient_department_id").references(() => departments.id, {
      onDelete: "restrict",
    }),
    addressingMode: text("addressing_mode").notNull(),
    inboxDepartmentId: uuid("inbox_department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    replyToMessageId: uuid("reply_to_message_id"),
    priority: integer("priority").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadSchemaVersion: text("payload_schema_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_sender_idempotency_idx")
      .on(table.senderAgentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("messages_correlation_idx").on(table.correlationId, table.createdAt),
    index("messages_sender_idx").on(table.senderAgentId, table.createdAt),
    index("messages_recipient_agent_idx").on(table.recipientAgentId, table.createdAt),
    index("messages_recipient_department_idx").on(table.recipientDepartmentId, table.createdAt),
    index("messages_created_at_id_idx").on(table.createdAt, table.id),
    check("messages_type_check", textIn("message_type", MESSAGE_TYPES)),
    check("messages_status_check", textIn("status", MESSAGE_STATUSES)),
    check("messages_addressing_mode_check", textIn("addressing_mode", ADDRESSING_MODES)),
    check("messages_protocol_check", sql`${table.protocolVersion} = '1.0'`),
    check("messages_payload_schema_check", sql`${table.payloadSchemaVersion} = '1.0'`),
    check("messages_priority_check", sql`${table.priority} between 0 and 9`),
    check(
      "messages_addressing_check",
      sql`(
        (${table.addressingMode} = 'agent' and ${table.recipientAgentId} is not null and ${table.recipientDepartmentId} is null)
        or
        (${table.addressingMode} = 'department' and ${table.recipientDepartmentId} is not null and ${table.recipientAgentId} is null)
      )`,
    ),
  ],
);

export const messageOutbox = pgTable(
  "message_outbox",
  {
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => iacpMessages.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("message_outbox_message_attempt_unique").on(table.messageId, table.attempt),
    index("message_outbox_claim_idx").on(table.status, table.availableAt),
    index("message_outbox_lease_idx").on(table.leaseUntil),
    check("message_outbox_status_check", textIn("status", OUTBOX_STATUSES)),
    check("message_outbox_attempt_check", sql`${table.attempt} > 0`),
  ],
);

export const messageProcessingRecords = pgTable(
  "message_processing_records",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => iacpMessages.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    owner: text("owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("message_processing_status_idx").on(table.status),
    check("message_processing_status_check", textIn("status", PROCESSING_STATUSES)),
  ],
);

export const messageDeliveryAttempts = pgTable(
  "message_delivery_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => iacpMessages.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").notNull(),
    error: text("error"),
    workerId: text("worker_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("message_delivery_attempts_message_idx").on(table.messageId, table.createdAt)],
);

export const messageDeadLetters = pgTable(
  "message_dead_letters",
  {
    id: uuid("id").primaryKey(),
    messageId: uuid("message_id").references(() => iacpMessages.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    detail: text("detail").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    status: text("status").notNull(),
    redrivenAt: timestamp("redriven_at", { withTimezone: true }),
    redrivenBy: text("redriven_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_dead_letters_one_open_idx")
      .on(table.messageId)
      .where(sql`${table.status} = 'open' and ${table.messageId} is not null`),
    index("message_dead_letters_created_idx").on(table.createdAt, table.id),
    check("message_dead_letters_status_check", textIn("status", DEAD_LETTER_STATUSES)),
  ],
);

export const objectiveRuns = pgTable(
  "objective_runs",
  {
    id: uuid("id").primaryKey(),
    submitterPrincipalId: uuid("submitter_principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    objectiveText: text("objective_text").notNull(),
    status: text("status").notNull(),
    origin: text("origin").notNull().default("human"),
    correlationId: uuid("correlation_id").notNull(),
    failureReason: text("failure_reason"),
    finalOutput: text("final_output"),
    executionAuthorized: boolean("execution_authorized").notNull(),
    planCorrections: integer("plan_corrections").notNull().default(0),
    memoryProfile: text("memory_profile").notNull(),
    primaryModelId: uuid("primary_model_id")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    operationalModelId: uuid("operational_model_id").references(() => models.id, {
      onDelete: "restrict",
    }),
    maxInferenceRequests: integer("max_inference_requests").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    maxEstimatedTokens: integer("max_estimated_tokens").notNull(),
    maxTaskAttempts: integer("max_task_attempts").notNull(),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull(),
    maxDurationMs: integer("max_duration_ms").notNull(),
    consumedRequests: integer("consumed_requests").notNull().default(0),
    reservedRequests: integer("reserved_requests").notNull().default(0),
    consumedInputTokens: integer("consumed_input_tokens").notNull().default(0),
    consumedOutputTokens: integer("consumed_output_tokens").notNull().default(0),
    estimatedInputTokens: integer("estimated_input_tokens").notNull().default(0),
    estimatedOutputTokens: integer("estimated_output_tokens").notNull().default(0),
    reservedOutputTokens: integer("reserved_output_tokens").notNull().default(0),
    estimatedCostUsdMicros: bigint("estimated_cost_usd_micros", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    executionPath: text("execution_path"),
    executionRationale: text("execution_rationale"),
    planningCompletedAt: timestamp("planning_completed_at", { withTimezone: true }),
    synthesisStartedAt: timestamp("synthesis_started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("objective_runs_status_idx").on(table.status, table.createdAt),
    index("objective_runs_submitter_idx").on(table.submitterPrincipalId, table.createdAt),
    check("objective_runs_status_check", textIn("status", OBJECTIVE_STATUSES)),
    check("objective_runs_origin_check", sql`${table.origin} in ('human', 'autonomous')`),
    check("objective_runs_profile_check", sql`${table.memoryProfile} in ('shared', 'split')`),
    check("objective_runs_limits_check", sql`${table.maxInferenceRequests} > 0`),
    check(
      "objective_runs_execution_path_check",
      sql`${table.executionPath} is null or ${textIn("execution_path", ["direct", "lightweight", "full"])}`,
    ),
  ],
);

export const objectivePlans = pgTable(
  "objective_plans",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectiveRuns.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    valid: boolean("valid").notNull(),
    errors: jsonb("errors").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("objective_plans_version_unique").on(table.objectiveId, table.version),
    index("objective_plans_objective_idx").on(table.objectiveId, table.version),
  ],
);

export const objectiveTasks = pgTable(
  "objective_tasks",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectiveRuns.id, { onDelete: "restrict" }),
    localId: text("local_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    departmentSlug: text("department_slug").notNull(),
    taskType: text("task_type").notNull(),
    objectiveText: text("objective_text").notNull(),
    expectedOutput: text("expected_output").notNull(),
    dependsOn: uuid("depends_on").array().notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull(),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    requestMessageId: uuid("request_message_id"),
    error: text("error"),
    resultSummary: text("result_summary"),
    deadline: timestamp("deadline", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("objective_tasks_local_unique").on(table.objectiveId, table.localId),
    index("objective_tasks_status_idx").on(table.status, table.createdAt),
    index("objective_tasks_objective_idx").on(table.objectiveId),
    check("objective_tasks_status_check", textIn("status", TASK_STATUSES)),
    check("objective_tasks_type_check", textIn("task_type", TASK_TYPES)),
    check("objective_tasks_attempt_check", sql`${table.attempt} > 0`),
  ],
);

export const taskAssignments = pgTable(
  "task_assignments",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => objectiveTasks.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_assignments_task_idx").on(table.taskId, table.attempt)],
);

export const taskResults = pgTable(
  "task_results",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => objectiveTasks.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    messageId: uuid("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("task_results_attempt_unique").on(table.taskId, table.attempt)],
);

export const inferenceRequests = pgTable(
  "inference_requests",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => objectiveTasks.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    purpose: text("purpose").notNull(),
    registryModelId: uuid("registry_model_id")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    intendedModelId: uuid("intended_model_id")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    requestedAlias: text("requested_alias").notNull(),
    status: text("status").notNull(),
    reservedOutputTokens: integer("reserved_output_tokens").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    responseText: text("response_text"),
    error: text("error"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("inference_requests_key_unique").on(table.idempotencyKey),
    index("inference_requests_objective_idx").on(table.objectiveId, table.createdAt),
    index("inference_requests_department_idx").on(table.departmentId, table.createdAt),
    index("inference_requests_adhoc_idx").on(table.createdAt),
    check("inference_requests_status_check", textIn("status", INFERENCE_REQUEST_STATUSES)),
    check(
      "inference_requests_purpose_check",
      sql`${table.purpose} in ('plan', 'correct', 'specialist', 'synthesize', 'monitor', 'routing', 'join_approval')`,
    ),
  ],
);

export const inferenceUsage = pgTable(
  "inference_usage",
  {
    requestId: uuid("request_id")
      .primaryKey()
      .references(() => inferenceRequests.id, { onDelete: "restrict" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    tokenSource: text("token_source").notNull(),
    servedModel: text("served_model").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    estimatedCostUsdMicros: bigint("estimated_cost_usd_micros", { mode: "number" }),
    overrideApplied: boolean("override_applied").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "inference_usage_source_check",
      sql`${table.tokenSource} in ('observed', 'unavailable', 'estimated')`,
    ),
  ],
);

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("workflow_events_objective_idx").on(table.objectiveId, table.createdAt)],
);

export const modelRuntimes = pgTable(
  "model_runtimes",
  {
    modelId: uuid("model_id")
      .primaryKey()
      .references(() => models.id, { onDelete: "restrict" }),
    runtimeStatus: text("runtime_status").notNull(),
    endpointUrl: text("endpoint_url"),
    expectedAlias: text("expected_alias"),
    loadedModelId: text("loaded_model_id"),
    lastError: text("last_error"),
    probedAt: timestamp("probed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "model_runtimes_status_check",
      sql`${table.runtimeStatus} in ('not_deployed', 'loading', 'ready', 'unavailable', 'failed')`,
    ),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  role: text("role").notNull(),
  beatAt: timestamp("beat_at", { withTimezone: true }).notNull(),
  detail: text("detail"),
});

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope").notNull(),
    category: text("category").notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    status: text("status").notNull(),
    qualityScore: doublePrecision("quality_score"),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    contentHash: text("content_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => memories.id, { onDelete: "restrict" }),
    originAgentId: uuid("origin_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    createdBy: text("created_by").notNull(),
    embeddingError: text("embedding_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("memories_idempotency_key_unique").on(table.idempotencyKey),
    index("memories_scope_status_idx").on(table.scope, table.status, table.createdAt),
    index("memories_owner_idx").on(table.ownerAgentId),
    index("memories_department_idx").on(table.departmentId),
    index("memories_hash_idx").on(table.contentHash),
    check("memories_scope_check", sql`${table.scope} in ('agent', 'department', 'colony')`),
    check("memories_category_check", sql`${table.category} in ('episodic', 'semantic', 'procedural', 'failure', 'operational')`),
    check("memories_provenance_check", sql`${table.provenance} in ('model_generated', 'system_observed', 'user_provided', 'externally_verified')`),
    check("memories_status_check", sql`${table.status} in ('candidate', 'validated', 'disputed', 'superseded', 'archived', 'expired', 'forgetting_requested', 'forgotten')`),
    check(
      "memories_scope_owner_check",
      sql`(${table.scope} = 'agent' and ${table.ownerAgentId} is not null and ${table.departmentId} is not null) or (${table.scope} = 'department' and ${table.ownerAgentId} is null and ${table.departmentId} is not null) or (${table.scope} = 'colony' and ${table.ownerAgentId} is null and ${table.departmentId} is null)`,
    ),
  ],
);

export const memoryEmbeddings = pgTable("memory_embeddings", {
  memoryId: uuid("memory_id")
    .primaryKey()
    .references(() => memories.id, { onDelete: "restrict" }),
  modelName: text("model_name").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memorySources = pgTable(
  "memory_sources",
  {
    id: uuid("id").primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    objectiveId: uuid("objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => objectiveTasks.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").references(() => iacpMessages.id, { onDelete: "restrict" }),
    sourceMemoryId: uuid("source_memory_id").references((): AnyPgColumn => memories.id, { onDelete: "restrict" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("memory_sources_objective_idx").on(table.objectiveId), index("memory_sources_memory_idx").on(table.memoryId)],
);

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    id: uuid("id").primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("memory_revisions_memory_revision_unique").on(table.memoryId, table.revision)],
);

export const memoryPromotionRequests = pgTable("memory_promotion_requests", {
  id: uuid("id").primaryKey(),
  memoryId: uuid("memory_id")
    .notNull()
    .references(() => memories.id, { onDelete: "restrict" }),
  fromScope: text("from_scope").notNull(),
  toScope: text("to_scope").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  proposedBy: text("proposed_by").notNull(),
  decidedBy: text("decided_by"),
  decisionReason: text("decision_reason"),
  createdMemoryId: uuid("created_memory_id").references(() => memories.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const memoryConsolidationRecords = pgTable("memory_consolidation_records", {
  id: uuid("id").primaryKey(),
  keeperId: uuid("keeper_id")
    .notNull()
    .references(() => memories.id, { onDelete: "restrict" }),
  mergedIds: uuid("merged_ids").array().notNull(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryContradictions = pgTable(
  "memory_contradictions",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    otherMemoryId: uuid("other_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.memoryId, table.otherMemoryId] })],
);

export const memoryRetrievalEvents = pgTable("memory_retrieval_events", {
  id: uuid("id").primaryKey(),
  objectiveId: uuid("objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
  taskId: uuid("task_id").references(() => objectiveTasks.id, { onDelete: "restrict" }),
  actorId: text("actor_id").notNull(),
  queryHash: text("query_hash").notNull(),
  mode: text("mode").notNull(),
  hitCount: integer("hit_count").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryRetrievalHits = pgTable(
  "memory_retrieval_hits",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => memoryRetrievalEvents.id, { onDelete: "restrict" }),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    rank: integer("rank").notNull(),
    score: doublePrecision("score").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.memoryId] })],
);

export const memoryEmbeddingUsage = pgTable("memory_embedding_usage", {
  id: uuid("id").primaryKey(),
  modelName: text("model_name").notNull(),
  vectorCount: integer("vector_count").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  success: boolean("success").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const TRAINING_RUN_STATUSES = [
  "proposed",
  "awaiting_approval",
  "queued",
  "preparing",
  "training",
  "evaluating",
  "completed",
  "failed",
  "cancelled",
] as const;

const TRAINABLE_KINDS = ["trainable_checkpoint"] as const;
const DATASET_VERSION_STATUSES = ["sealed"] as const;
const EXAMPLE_SPLITS = ["train", "validation", "test"] as const;
const EXAMPLE_SOURCES = ["curated_arithmetic", "supplied", "memory", "objective_trace"] as const;
const ARTIFACT_KINDS = ["adapter", "checkpoint"] as const;
const ARTIFACT_FORMATS = ["safetensors", "float32-bin"] as const;
const CANDIDATE_STATUSES = ["experimental", "rejected", "approved", "retired", "revoked", "quarantined"] as const;
const PROMOTION_STATUSES = ["proposed", "approved", "rejected"] as const;

export const trainableModels = pgTable(
  "trainable_models",
  {
    id: uuid("id").primaryKey(),
    registryModelId: uuid("registry_model_id")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    modelFamily: text("model_family").notNull(),
    source: text("source").notNull(),
    revision: text("revision").notNull(),
    parameterCount: bigint("parameter_count", { mode: "number" }).notNull(),
    precision: text("precision").notNull(),
    architecture: text("architecture").notNull(),
    tokenizerId: text("tokenizer_id").notNull(),
    contextLength: integer("context_length").notNull(),
    framework: text("framework").notNull(),
    frameworkVersion: text("framework_version").notNull(),
    artifactUri: text("artifact_uri").notNull(),
    sha256: text("sha256").notNull(),
    license: text("license").notNull(),
    availableLocally: boolean("available_locally").notNull(),
    eligibleForTraining: boolean("eligible_for_training").notNull(),
    servingReady: boolean("serving_ready").notNull(),
    compatibility: jsonb("compatibility").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("trainable_models_registry_sha_unique").on(table.registryModelId, table.sha256),
    index("trainable_models_family_idx").on(table.modelFamily),
    check("trainable_models_kind_check", textIn("kind", TRAINABLE_KINDS)),
    check("trainable_models_parameter_count_check", sql`${table.parameterCount} > 0`),
    check("trainable_models_context_check", sql`${table.contextLength} > 0`),
    check("trainable_models_sha_check", sql`char_length(${table.sha256}) = 64`),
  ],
);

export const trainingDatasets = pgTable(
  "training_datasets",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    taskDomain: text("task_domain").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("training_datasets_idempotency_key_unique").on(table.idempotencyKey),
    index("training_datasets_created_at_idx").on(table.createdAt, table.id),
  ],
);

export const trainingDatasetVersions = pgTable(
  "training_dataset_versions",
  {
    id: uuid("id").primaryKey(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => trainingDatasets.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    splitSeed: integer("split_seed").notNull(),
    status: text("status").notNull(),
    trainCount: integer("train_count").notNull(),
    validationCount: integer("validation_count").notNull(),
    testCount: integer("test_count").notNull(),
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("training_dataset_versions_dataset_version_unique").on(table.datasetId, table.version),
    check("training_dataset_versions_status_check", textIn("status", DATASET_VERSION_STATUSES)),
    check("training_dataset_versions_version_check", sql`${table.version} >= 1`),
    check("training_dataset_versions_counts_check", sql`${table.trainCount} >= 0 and ${table.validationCount} >= 0 and ${table.testCount} >= 0`),
    check("training_dataset_versions_hash_check", sql`char_length(${table.contentHash}) = 64`),
  ],
);

export const trainingExamples = pgTable(
  "training_examples",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => trainingDatasetVersions.id, { onDelete: "restrict" }),
    split: text("split").notNull(),
    groupKey: text("group_key").notNull(),
    source: text("source").notNull(),
    license: text("license").notNull(),
    inputText: text("input_text").notNull(),
    expectedOutput: text("expected_output").notNull(),
    validationStatus: text("validation_status").notNull(),
    sourceMemoryId: uuid("source_memory_id").references(() => memories.id, { onDelete: "restrict" }),
    sourceObjectiveId: uuid("source_objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("training_examples_version_group_unique").on(table.versionId, table.groupKey),
    unique("training_examples_version_hash_unique").on(table.versionId, table.contentHash),
    index("training_examples_split_idx").on(table.versionId, table.split),
    check("training_examples_split_check", textIn("split", EXAMPLE_SPLITS)),
    check("training_examples_source_check", textIn("source", EXAMPLE_SOURCES)),
    check("training_examples_validation_check", sql`${table.validationStatus} = 'verified'`),
    check("training_examples_hash_check", sql`char_length(${table.contentHash}) = 64`),
  ],
);

export const trainingRuns = pgTable(
  "training_runs",
  {
    id: uuid("id").primaryKey(),
    datasetVersionId: uuid("dataset_version_id")
      .notNull()
      .references(() => trainingDatasetVersions.id, { onDelete: "restrict" }),
    trainableModelId: uuid("trainable_model_id")
      .notNull()
      .references(() => trainableModels.id, { onDelete: "restrict" }),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => trainingRuns.id, { onDelete: "restrict" }),
    profile: text("profile").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    seed: integer("seed").notNull(),
    attempt: integer("attempt").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("training_runs_idempotency_key_unique").on(table.idempotencyKey),
    index("training_runs_status_idx").on(table.status, table.createdAt),
    check("training_runs_status_check", textIn("status", TRAINING_RUN_STATUSES)),
    check("training_runs_attempt_check", sql`${table.attempt} >= 1 and ${table.attempt} <= ${table.maxAttempts}`),
    check("training_runs_seed_check", sql`${table.seed} >= 0`),
  ],
);

export const trainingRunMetrics = pgTable(
  "training_run_metrics",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => trainingRuns.id, { onDelete: "restrict" }),
    step: integer("step").notNull(),
    trainLoss: doublePrecision("train_loss"),
    validationLoss: doublePrecision("validation_loss"),
    learningRate: doublePrecision("learning_rate"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("training_run_metrics_run_step_idx").on(table.runId, table.step),
    check("training_run_metrics_step_check", sql`${table.step} >= 0`),
  ],
);

export const trainingArtifacts = pgTable(
  "training_artifacts",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => trainingRuns.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    relativePath: text("relative_path").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    format: text("format").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("training_artifacts_run_sha_unique").on(table.runId, table.sha256),
    check("training_artifacts_kind_check", textIn("kind", ARTIFACT_KINDS)),
    check("training_artifacts_format_check", textIn("format", ARTIFACT_FORMATS)),
    check("training_artifacts_size_check", sql`${table.byteSize} > 0 and ${table.byteSize} <= 200000000`),
    check("training_artifacts_sha_check", sql`char_length(${table.sha256}) = 64`),
  ],
);

export const modelAdapters = pgTable(
  "model_adapters",
  {
    id: uuid("id").primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => trainingArtifacts.id, { onDelete: "restrict" }),
    baseTrainableModelId: uuid("base_trainable_model_id")
      .notNull()
      .references(() => trainableModels.id, { onDelete: "restrict" }),
    rank: integer("rank").notNull(),
    alpha: doublePrecision("alpha").notNull(),
    dropout: doublePrecision("dropout").notNull(),
    targetModules: jsonb("target_modules").$type<string[]>().notNull(),
    trainableParameters: bigint("trainable_parameters", { mode: "number" }).notNull(),
    framework: text("framework").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("model_adapters_artifact_unique").on(table.artifactId),
    check("model_adapters_rank_check", sql`${table.rank} >= 1 and ${table.rank} <= 16`),
    check("model_adapters_parameters_check", sql`${table.trainableParameters} > 0`),
  ],
);

export const modelCandidates = pgTable(
  "model_candidates",
  {
    id: uuid("id").primaryKey(),
    adapterId: uuid("adapter_id")
      .notNull()
      .references(() => modelAdapters.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => trainingRuns.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("model_candidates_run_unique").on(table.runId),
    index("model_candidates_status_idx").on(table.status),
    check("model_candidates_status_check", textIn("status", CANDIDATE_STATUSES)),
  ],
);

export const candidateEvaluations = pgTable(
  "candidate_evaluations",
  {
    id: uuid("id").primaryKey(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => modelCandidates.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => trainingRuns.id, { onDelete: "restrict" }),
    baseline: jsonb("baseline").$type<Record<string, unknown>>().notNull(),
    candidate: jsonb("candidate").$type<Record<string, unknown>>().notNull(),
    acceptanceMet: boolean("acceptance_met").notNull(),
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull(),
    report: jsonb("report").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("candidate_evaluations_candidate_unique").on(table.candidateId)],
);

export const modelPromotionRequests = pgTable(
  "model_promotion_requests",
  {
    id: uuid("id").primaryKey(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => modelCandidates.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    proposedBy: text("proposed_by").notNull(),
    decidedBy: text("decided_by"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    index("model_promotion_requests_candidate_idx").on(table.candidateId, table.createdAt),
    check("model_promotion_requests_status_check", textIn("status", PROMOTION_STATUSES)),
  ],
);

export const modelVersionEvents = pgTable(
  "model_version_events",
  {
    id: uuid("id").primaryKey(),
    trainableModelId: uuid("trainable_model_id").references(() => trainableModels.id, { onDelete: "restrict" }),
    candidateId: uuid("candidate_id").references(() => modelCandidates.id, { onDelete: "restrict" }),
    runId: uuid("run_id").references(() => trainingRuns.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("model_version_events_run_idx").on(table.runId, table.createdAt)],
);

const BENCHMARK_STATUSES = ["draft", "published", "retired"] as const;
const GATE_DECISIONS = ["PASS", "FAIL", "INCONCLUSIVE", "QUARANTINED"] as const;
const ROUTE_KINDS = ["baseline", "candidate"] as const;
const ROLLBACK_STATUSES = ["requested", "approved", "completed", "failed"] as const;
const FORGETTING_STATUSES = ["requested", "approved", "completed", "rejected", "failed"] as const;
const LINEAGE_USES = ["definitely_used", "potentially_used", "not_used"] as const;

export const benchmarkSuites = pgTable("benchmark_suites", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const benchmarkVersions = pgTable(
  "benchmark_versions",
  {
    id: uuid("id").primaryKey(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => benchmarkSuites.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    description: text("description").notNull(),
    domain: text("domain").notNull(),
    source: text("source").notNull(),
    license: text("license").notNull(),
    protocol: text("protocol").notNull(),
    scorerId: text("scorer_id").notNull(),
    scorerVersion: text("scorer_version").notNull(),
    contentHash: text("content_hash").notNull(),
    promptTemplateHash: text("prompt_template_hash").notNull(),
    decoding: jsonb("decoding").$type<Record<string, unknown>>().notNull(),
    thresholds: jsonb("thresholds").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    sealed: boolean("sealed").notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("benchmark_versions_suite_version_unique").on(table.suiteId, table.version),
    check("benchmark_versions_status_check", textIn("status", BENCHMARK_STATUSES)),
  ],
);

export const benchmarkItems = pgTable(
  "benchmark_items",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => benchmarkVersions.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    domain: text("domain").notNull(),
    prompt: text("prompt").notNull(),
    expected: text("expected").notNull(),
    promptHash: text("prompt_hash").notNull(),
    sealed: boolean("sealed").notNull(),
  },
  (table) => [unique("benchmark_items_version_ordinal_unique").on(table.versionId, table.ordinal)],
);

export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: uuid("id").primaryKey(),
    benchmarkVersionId: uuid("benchmark_version_id")
      .notNull()
      .references(() => benchmarkVersions.id, { onDelete: "restrict" }),
    candidateId: uuid("candidate_id").references(() => modelCandidates.id, { onDelete: "restrict" }),
    trainableModelId: uuid("trainable_model_id").references(() => trainableModels.id, { onDelete: "restrict" }),
    baseSha256: text("base_sha256").notNull(),
    adapterSha256: text("adapter_sha256"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    decoding: jsonb("decoding").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  () => [check("evaluation_runs_status_check", textIn("status", ["completed", "failed"])), check("evaluation_runs_source_check", textIn("source", ["live", "historical"]))],
);

export const evaluationItemResults = pgTable(
  "evaluation_item_results",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    role: text("role").notNull(),
    rawOutput: text("raw_output").notNull(),
    taskCorrect: boolean("task_correct").notNull(),
    formatValid: boolean("format_valid").notNull(),
    strictIntegerMatch: boolean("strict_integer_match").notNull(),
    ambiguous: boolean("ambiguous").notNull(),
    equationValue: text("equation_value"),
  },
  (table) => [
    unique("evaluation_item_results_run_ordinal_role_unique").on(table.runId, table.ordinal, table.role),
    check("evaluation_item_results_role_check", textIn("role", ["baseline", "candidate"])),
  ],
);

export const evaluationReports = pgTable("evaluation_reports", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .unique()
    .references(() => evaluationRuns.id, { onDelete: "restrict" }),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const candidateGateDecisions = pgTable(
  "candidate_gate_decisions",
  {
    id: uuid("id").primaryKey(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => modelCandidates.id, { onDelete: "restrict" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => evaluationReports.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull(),
    policyHash: text("policy_hash").notNull(),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("candidate_gate_decisions_decision_check", textIn("decision", GATE_DECISIONS))],
);

export const experimentalRoutes = pgTable("experimental_routes", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  currentVersion: integer("current_version"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const experimentalRouteVersions = pgTable(
  "experimental_route_versions",
  {
    id: uuid("id").primaryKey(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => experimentalRoutes.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    kind: text("kind").notNull(),
    candidateId: uuid("candidate_id").references(() => modelCandidates.id, { onDelete: "restrict" }),
    trainableModelId: uuid("trainable_model_id")
      .notNull()
      .references(() => trainableModels.id, { onDelete: "restrict" }),
    adapterSha256: text("adapter_sha256"),
    baseSha256: text("base_sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("experimental_route_versions_route_version_unique").on(table.routeId, table.version),
    check("experimental_route_versions_kind_check", textIn("kind", ROUTE_KINDS)),
  ],
);

export const rollbackRequests = pgTable(
  "rollback_requests",
  {
    id: uuid("id").primaryKey(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => experimentalRoutes.id, { onDelete: "restrict" }),
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    error: text("error"),
    verification: jsonb("verification").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  () => [check("rollback_requests_status_check", textIn("status", ROLLBACK_STATUSES))],
);

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    scope: text("scope"),
    provenance: text("provenance"),
    maxAgeDays: integer("max_age_days"),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("retention_policies_name_version_unique").on(table.name, table.version),
    check("retention_policies_status_check", textIn("status", ["published"])),
  ],
);

export const forgettingRequests = pgTable(
  "forgetting_requests",
  {
    id: uuid("id").primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    impact: jsonb("impact").$type<Record<string, unknown>>().notNull(),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  () => [check("forgetting_requests_status_check", textIn("status", FORGETTING_STATUSES))],
);

export const lineageEdges = pgTable(
  "lineage_edges",
  {
    id: uuid("id").primaryKey(),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("lineage_edges_identity_unique").on(table.fromType, table.fromId, table.toType, table.toId, table.relation),
    check("lineage_edges_relation_check", textIn("relation", LINEAGE_USES)),
  ],
);

export const artifactContamination = pgTable(
  "artifact_contamination",
  {
    id: uuid("id").primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => trainingArtifacts.id, { onDelete: "restrict" }),
    forgettingRequestId: uuid("forgetting_request_id")
      .notNull()
      .references(() => forgettingRequests.id, { onDelete: "restrict" }),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("artifact_contamination_artifact_request_unique").on(table.artifactId, table.forgettingRequestId)],
);

const CAPABILITY_STATUSES = ["proposed", "experimental", "evaluated", "approved", "rejected", "revoked", "superseded"] as const;
const GAP_STATUSES = ["observed", "validated", "rejected", "aggregated"] as const;
const LEARNING_MECHANISMS = ["memory_acquisition", "memory_consolidation", "workflow", "retrieval", "lora", "knowledge_transfer", "no_action"] as const;
const CYCLE_STATUSES = ["OBSERVED", "GAP_VALIDATED", "OBJECTIVE_CREATED", "METHOD_SELECTED", "PROPOSAL_PENDING", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "EVALUATING", "AWAITING_PROMOTION", "ADOPTED", "REJECTED", "INCONCLUSIVE", "FAILED", "CANCELLED"] as const;
const OUTCOME_KINDS = ["MEMORY_IMPROVEMENT", "RETRIEVAL_IMPROVEMENT", "WORKFLOW_IMPROVEMENT", "TOOL_IMPROVEMENT", "MODEL_WEIGHT_IMPROVEMENT", "NO_VERIFIED_IMPROVEMENT"] as const;
const ASSIGNMENT_ROLES = ["shared_base", "experimental_adapter", "capability_adapter", "fallback"] as const;
const ASSIGNMENT_STATUSES = ["active", "superseded", "rejected"] as const;
const TRANSFER_STATUSES = ["pending", "accepted", "rejected"] as const;

export const departmentCapabilities = pgTable(
  "department_capabilities",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    domain: text("domain").notNull(),
    taskType: text("task_type").notNull(),
    description: text("description").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("department_capabilities_slug_unique").on(table.departmentId, table.slug)],
);

export const departmentCapabilityVersions = pgTable(
  "department_capability_versions",
  {
    id: uuid("id").primaryKey(),
    capabilityId: uuid("capability_id").notNull().references(() => departmentCapabilities.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    toolNames: jsonb("tool_names").$type<string[]>().notNull(),
    requiredPermissions: jsonb("required_permissions").$type<string[]>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evaluationRunId: uuid("evaluation_run_id").references(() => evaluationRuns.id, { onDelete: "restrict" }),
    benchmarkVersionId: uuid("benchmark_version_id").references(() => benchmarkVersions.id, { onDelete: "restrict" }),
    reliability: jsonb("reliability").$type<Record<string, unknown>>().notNull(),
    resources: jsonb("resources").$type<Record<string, unknown>>().notNull(),
    improvementKind: text("improvement_kind").notNull(),
    approvedBy: text("approved_by"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("department_capability_versions_unique").on(table.capabilityId, table.version),
    check("department_capability_versions_status_check", textIn("status", CAPABILITY_STATUSES)),
    check("department_capability_versions_kind_check", textIn("improvement_kind", OUTCOME_KINDS)),
  ],
);

export const capabilityGaps = pgTable(
  "capability_gaps",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    capabilityId: uuid("capability_id").references(() => departmentCapabilities.id, { onDelete: "restrict" }),
    taskCategory: text("task_category").notNull(),
    fingerprint: text("fingerprint").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    failureCount: integer("failure_count").notNull(),
    severity: text("severity").notNull(),
    impact: text("impact").notNull(),
    baseline: jsonb("baseline").$type<Record<string, unknown>>().notNull(),
    proposedMethod: text("proposed_method").notNull(),
    resources: jsonb("resources").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("capability_gaps_fingerprint_unique").on(table.departmentId, table.fingerprint),
    check("capability_gaps_status_check", textIn("status", GAP_STATUSES)),
    check("capability_gaps_method_check", textIn("proposed_method", LEARNING_MECHANISMS)),
    check("capability_gaps_severity_check", textIn("severity", ["low", "medium", "high"])),
  ],
);

export const learningObjectives = pgTable(
  "learning_objectives",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    gapId: uuid("gap_id").notNull().references(() => capabilityGaps.id, { onDelete: "restrict" }),
    capabilityId: uuid("capability_id").references(() => departmentCapabilities.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    weakness: text("weakness").notNull(),
    mechanism: text("mechanism").notNull(),
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull(),
    benchmarkVersionId: uuid("benchmark_version_id").references(() => benchmarkVersions.id, { onDelete: "restrict" }),
    baselineRef: text("baseline_ref"),
    budget: jsonb("budget").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("learning_objectives_version_unique").on(table.gapId, table.version),
    check("learning_objectives_mechanism_check", textIn("mechanism", LEARNING_MECHANISMS)),
  ],
);

export const learningCycles = pgTable(
  "learning_cycles",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id").references(() => learningObjectives.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    method: text("method").notNull(),
    outcomeKind: text("outcome_kind"),
    trainingRunId: uuid("training_run_id").references(() => trainingRuns.id, { onDelete: "restrict" }),
    evaluationRunId: uuid("evaluation_run_id").references(() => evaluationRuns.id, { onDelete: "restrict" }),
    gateDecision: text("gate_decision"),
    transferId: uuid("transfer_id"),
    memoryId: uuid("memory_id").references(() => memories.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    correlationId: text("correlation_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("learning_cycles_status_check", textIn("status", CYCLE_STATUSES)),
    check("learning_cycles_method_check", textIn("method", LEARNING_MECHANISMS)),
    index("learning_cycles_department_idx").on(table.departmentId, table.status),
  ],
);

export const learningCycleEvents = pgTable("learning_cycle_events", {
  id: uuid("id").primaryKey(),
  cycleId: uuid("cycle_id").notNull().references(() => learningCycles.id, { onDelete: "restrict" }),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const departmentModelAssignments = pgTable(
  "department_model_assignments",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    registryModelId: uuid("registry_model_id").notNull().references(() => models.id, { onDelete: "restrict" }),
    trainableModelId: uuid("trainable_model_id").references(() => trainableModels.id, { onDelete: "restrict" }),
    candidateId: uuid("candidate_id").references(() => modelCandidates.id, { onDelete: "restrict" }),
    adapterSha256: text("adapter_sha256"),
    modelFamily: text("model_family").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("department_model_assignments_version_unique").on(table.departmentId, table.version),
    check("department_model_assignments_role_check", textIn("role", ASSIGNMENT_ROLES)),
    check("department_model_assignments_status_check", textIn("status", ASSIGNMENT_STATUSES)),
  ],
);

export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => objectiveTasks.id, { onDelete: "restrict" }),
    objectiveId: uuid("objective_id").notNull().references(() => objectiveRuns.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    assignmentId: uuid("assignment_id").references(() => departmentModelAssignments.id, { onDelete: "restrict" }),
    assignmentVersion: integer("assignment_version"),
    registryModelId: uuid("registry_model_id").notNull().references(() => models.id, { onDelete: "restrict" }),
    servingModel: text("serving_model").notNull(),
    modelDigest: text("model_digest"),
    adapterId: text("adapter_id"),
    adapterVersion: text("adapter_version"),
    policyVersion: text("policy_version").notNull(),
    authorization: text("authorization").notNull(),
    reasonCode: text("reason_code").notNull(),
    runtimeEvidence: jsonb("runtime_evidence").$type<Record<string, unknown>>().notNull(),
    budgetOutcome: text("budget_outcome").notNull(),
    resourceOutcome: text("resource_outcome").notNull(),
    fallbackStatus: text("fallback_status").notNull(),
    executionVerification: text("execution_verification").notNull(),
    capabilityNote: text("capability_note").notNull(),
    servingInstanceId: uuid("serving_instance_id"),
    endpointReference: text("endpoint_reference"),
    agentId: uuid("agent_id"),
    servingPolicyVersion: text("serving_policy_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("routing_decisions_task_unique").on(table.taskId).where(sql`${table.taskId} is not null`),
    uniqueIndex("routing_decisions_objective_purpose_unique").on(table.objectiveId, table.purpose).where(sql`${table.taskId} is null`),
    check("routing_decisions_authorization_check", sql`${table.authorization} in ('authorized', 'denied')`),
    check("routing_decisions_fallback_check", sql`${table.fallbackStatus} = 'disabled'`),
    check("routing_decisions_verification_check", sql`${table.executionVerification} in ('unverified', 'matched', 'mismatch')`),
  ],
);

export const knowledgeTransfers = pgTable(
  "knowledge_transfers",
  {
    id: uuid("id").primaryKey(),
    originDepartmentId: uuid("origin_department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    destinationDepartmentId: uuid("destination_department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    sourceMemoryId: uuid("source_memory_id").references(() => memories.id, { onDelete: "restrict" }),
    summary: text("summary").notNull(),
    provenance: text("provenance").notNull(),
    trust: text("trust").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    restrictions: text("restrictions").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    cycleId: uuid("cycle_id").references(() => learningCycles.id, { onDelete: "restrict" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("knowledge_transfers_status_check", textIn("status", TRANSFER_STATUSES))],
);

export const knowledgeValidations = pgTable(
  "knowledge_validations",
  {
    id: uuid("id").primaryKey(),
    transferId: uuid("transfer_id").notNull().unique().references(() => knowledgeTransfers.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    decidedBy: text("decided_by").notNull(),
    reason: text("reason").notNull(),
    acceptedMemoryId: uuid("accepted_memory_id").references(() => memories.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("knowledge_validations_decision_check", textIn("decision", ["accept", "reject"]))],
);

export const learningOutcomes = pgTable(
  "learning_outcomes",
  {
    id: uuid("id").primaryKey(),
    cycleId: uuid("cycle_id").notNull().unique().references(() => learningCycles.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    verified: boolean("verified").notNull(),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("learning_outcomes_kind_check", textIn("kind", OUTCOME_KINDS))],
);

export const learningBudgets = pgTable("learning_budgets", {
  id: uuid("id").primaryKey(),
  cycleId: uuid("cycle_id").notNull().unique().references(() => learningCycles.id, { onDelete: "restrict" }),
  maxInferenceCalls: integer("max_inference_calls").notNull(),
  maxTrainingSteps: integer("max_training_steps").notNull(),
  maxRuntimeMs: integer("max_runtime_ms").notNull(),
  usedInferenceCalls: integer("used_inference_calls").notNull(),
  usedTrainingSteps: integer("used_training_steps").notNull(),
  usedRuntimeMs: integer("used_runtime_ms").notNull(),
});

const IMPROVEMENT_CLASSES = ["VERIFIED_IMPROVEMENT", "NO_VERIFIED_IMPROVEMENT", "VERIFIED_REGRESSION", "INCONCLUSIVE", "EVALUATION_INVALID"] as const;
const DEPLOYMENT_ELIGIBILITY = ["eligible", "ineligible", "exceptional"] as const;
const DEPLOYMENT_PURPOSES = ["improvement", "exceptional"] as const;
const COLLABORATION_CLASSES = ["consultation", "specialist", "joint"] as const;
const COLLABORATION_STATUSES = ["open", "closed", "expired"] as const;
const PARTICIPANT_ROLES = ["owner", "contributor"] as const;
const PARTICIPANT_STATUSES = ["invited", "active", "removed"] as const;
const ENTRY_KINDS = ["request_context", "answer", "contribution", "shared_decision"] as const;
const ENTRY_STATUSES = ["active", "expired", "archived", "promoted"] as const;

export const improvementDecisions = pgTable(
  "improvement_decisions",
  {
    id: uuid("id").primaryKey(),
    evaluationRunId: uuid("evaluation_run_id").references(() => evaluationRuns.id, { onDelete: "restrict" }),
    cycleId: uuid("cycle_id").references(() => learningCycles.id, { onDelete: "restrict" }),
    policyVersion: text("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    safetyGate: text("safety_gate").notNull(),
    safetyGateVersion: text("safety_gate_version").notNull(),
    classification: text("classification").notNull(),
    deploymentEligibility: text("deployment_eligibility").notNull(),
    baselineRef: text("baseline_ref"),
    candidateId: uuid("candidate_id").references(() => modelCandidates.id, { onDelete: "restrict" }),
    sampleCount: integer("sample_count").notNull(),
    effectSize: doublePrecision("effect_size").notNull(),
    uncertainty: jsonb("uncertainty").$type<Record<string, unknown>>().notNull(),
    retention: jsonb("retention").$type<Record<string, unknown>>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    rationale: text("rationale").notNull(),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("improvement_decisions_run_policy_unique").on(table.evaluationRunId, table.policyVersion).where(sql`${table.evaluationRunId} is not null`),
    check("improvement_decisions_class_check", textIn("classification", IMPROVEMENT_CLASSES)),
    check("improvement_decisions_eligibility_check", textIn("deployment_eligibility", DEPLOYMENT_ELIGIBILITY)),
  ],
);

export const deploymentDecisions = pgTable(
  "deployment_decisions",
  {
    id: uuid("id").primaryKey(),
    cycleId: uuid("cycle_id").notNull().references(() => learningCycles.id, { onDelete: "restrict" }),
    improvementDecisionId: uuid("improvement_decision_id").references(() => improvementDecisions.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    eligibility: text("eligibility").notNull(),
    adopted: boolean("adopted").notNull(),
    rationale: text("rationale").notNull(),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("deployment_decisions_cycle_purpose_unique").on(table.cycleId, table.purpose),
    check("deployment_decisions_purpose_check", textIn("purpose", DEPLOYMENT_PURPOSES)),
    check("deployment_decisions_eligibility_check", textIn("eligibility", DEPLOYMENT_ELIGIBILITY)),
  ],
);

export const collaborationContexts = pgTable(
  "collaboration_contexts",
  {
    id: uuid("id").primaryKey(),
    classification: text("classification").notNull(),
    ownerDepartmentId: uuid("owner_department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  () => [
    check("collaboration_contexts_class_check", textIn("classification", COLLABORATION_CLASSES)),
    check("collaboration_contexts_status_check", textIn("status", COLLABORATION_STATUSES)),
  ],
);

export const collaborationParticipants = pgTable(
  "collaboration_participants",
  {
    id: uuid("id").primaryKey(),
    contextId: uuid("context_id").notNull().references(() => collaborationContexts.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("collaboration_participants_context_department_unique").on(table.contextId, table.departmentId),
    check("collaboration_participants_role_check", textIn("role", PARTICIPANT_ROLES)),
    check("collaboration_participants_status_check", textIn("status", PARTICIPANT_STATUSES)),
  ],
);

export const collaborationEntries = pgTable(
  "collaboration_entries",
  {
    id: uuid("id").primaryKey(),
    contextId: uuid("context_id").notNull().references(() => collaborationContexts.id, { onDelete: "restrict" }),
    authorDepartmentId: uuid("author_department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    promotedMemoryId: uuid("promoted_memory_id").references(() => memories.id, { onDelete: "restrict" }),
    sourceMemoryId: uuid("source_memory_id").references(() => memories.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("collaboration_entries_context_idx").on(table.contextId, table.status),
    check("collaboration_entries_kind_check", textIn("kind", ENTRY_KINDS)),
    check("collaboration_entries_status_check", textIn("status", ENTRY_STATUSES)),
    check("collaboration_entries_provenance_check", sql`${table.provenance} in ('model_generated', 'system_observed', 'user_provided', 'externally_verified')`),
  ],
);

export const memoryOwnership = pgTable(
  "memory_ownership",
  {
    memoryId: uuid("memory_id").primaryKey().references(() => memories.id, { onDelete: "restrict" }),
    originatingDepartmentId: uuid("originating_department_id").references(() => departments.id, { onDelete: "restrict" }),
    primaryOwnerDepartmentId: uuid("primary_owner_department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    recipientDepartmentId: uuid("recipient_department_id").references(() => departments.id, { onDelete: "restrict" }),
    classification: text("classification").notNull(),
    collaborationId: uuid("collaboration_id").references(() => collaborationContexts.id, { onDelete: "restrict" }),
    retentionPolicy: text("retention_policy").notNull(),
    promotionReason: text("promotion_reason").notNull(),
    validationStatus: text("validation_status").notNull(),
    sourceMessageId: uuid("source_message_id").references(() => iacpMessages.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("memory_ownership_class_check", textIn("classification", COLLABORATION_CLASSES)),
    check("memory_ownership_validation_check", textIn("validation_status", ["validated", "unverified"])),
  ],
);

export const trainingExperiments = pgTable(
  "training_experiments",
  {
    id: uuid("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    methodId: text("method_id").notNull(),
    modelId: text("model_id").notNull(),
    modelRevision: text("model_revision").notNull(),
    adapterSha256: text("adapter_sha256"),
    problem: text("problem").notNull(),
    datasetSize: integer("dataset_size").notNull(),
    learningRate: doublePrecision("learning_rate").notNull(),
    steps: integer("steps").notNull(),
    exposures: doublePrecision("exposures").notNull(),
    target: text("target").notNull(),
    seed: integer("seed").notNull(),
    devAccuracy: doublePrecision("dev_accuracy"),
    baselineAccuracy: doublePrecision("baseline_accuracy"),
    sealedAccuracy: doublePrecision("sealed_accuracy"),
    retentionOk: boolean("retention_ok"),
    failureClass: text("failure_class"),
    recommendation: text("recommendation").notNull(),
    evidencePath: text("evidence_path").notNull(),
    stopped: boolean("stopped").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("training_experiments_target_check", textIn("target", ["answer", "structured"]))],
);

export const ledgerTopics = pgTable("ledger_topics", {
  id: uuid("id").primaryKey(),
  departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
  provenance: text("provenance").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerTopicEvents = pgTable(
  "ledger_topic_events",
  {
    id: uuid("id").primaryKey(),
    topicId: uuid("topic_id").notNull().references(() => ledgerTopics.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    name: text("name"),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("ledger_topic_events_type_check", textIn("event_type", ["rename", "describe", "deprecate"]))],
);

export const ledgerProposals = pgTable(
  "ledger_proposals",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    proposedBy: text("proposed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("ledger_proposals_kind_check", textIn("kind", ["taxonomy", "mapping", "measurement"]))],
);

export const ledgerDecisions = pgTable(
  "ledger_decisions",
  {
    id: uuid("id").primaryKey(),
    proposalId: uuid("proposal_id").notNull().unique().references(() => ledgerProposals.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("ledger_decisions_decision_check", textIn("decision", ["approved", "rejected"]))],
);

export const ledgerTaxonomyVersions = pgTable(
  "ledger_taxonomy_versions",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    proposalId: uuid("proposal_id").notNull().references(() => ledgerProposals.id, { onDelete: "restrict" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("ledger_taxonomy_versions_unique").on(table.departmentId, table.version)],
);

export const ledgerTaxonomyEdges = pgTable(
  "ledger_taxonomy_edges",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id").notNull().references(() => ledgerTaxonomyVersions.id, { onDelete: "restrict" }),
    topicId: uuid("topic_id").notNull().references(() => ledgerTopics.id, { onDelete: "restrict" }),
    parentTopicId: uuid("parent_topic_id").references(() => ledgerTopics.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    targetDepartmentId: uuid("target_department_id").references(() => departments.id, { onDelete: "restrict" }),
  },
  (table) => [
    check("ledger_taxonomy_edges_kind_check", textIn("kind", ["parent", "cross_link"])),
    check("ledger_taxonomy_edges_status_check", textIn("status", ["active", "deprecated"])),
    check("ledger_taxonomy_edges_not_self", sql`${table.parentTopicId} is null or ${table.parentTopicId} <> ${table.topicId}`),
    uniqueIndex("ledger_edge_one_parent").on(table.versionId, table.topicId).where(sql`${table.kind} = 'parent'`),
    uniqueIndex("ledger_edge_cross_link").on(table.versionId, table.topicId, table.parentTopicId).where(sql`${table.kind} = 'cross_link'`),
  ],
);

export const ledgerMappingVersions = pgTable(
  "ledger_mapping_versions",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    taxonomyVersionId: uuid("taxonomy_version_id").notNull().references(() => ledgerTaxonomyVersions.id, { onDelete: "restrict" }),
    proposalId: uuid("proposal_id").notNull().references(() => ledgerProposals.id, { onDelete: "restrict" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("ledger_mapping_versions_unique").on(table.departmentId, table.version)],
);

export const ledgerTopicMappings = pgTable(
  "ledger_topic_mappings",
  {
    id: uuid("id").primaryKey(),
    mappingVersionId: uuid("mapping_version_id").notNull().references(() => ledgerMappingVersions.id, { onDelete: "restrict" }),
    itemId: text("item_id").notNull(),
    contentDigest: text("content_digest").notNull(),
    topicId: uuid("topic_id").notNull().references(() => ledgerTopics.id, { onDelete: "restrict" }),
    weight: doublePrecision("weight"),
    provenance: text("provenance").notNull(),
  },
  (table) => [unique("ledger_topic_mappings_item_topic_unique").on(table.mappingVersionId, table.itemId, table.topicId)],
);

export const ledgerSnapshots = pgTable("ledger_snapshots", {
  id: uuid("id").primaryKey(),
  departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
  topicId: uuid("topic_id").notNull().references(() => ledgerTopics.id, { onDelete: "restrict" }),
  taxonomyVersionId: uuid("taxonomy_version_id").notNull().references(() => ledgerTaxonomyVersions.id, { onDelete: "restrict" }),
  mappingVersionId: uuid("mapping_version_id").notNull().references(() => ledgerMappingVersions.id, { onDelete: "restrict" }),
  evaluationRunId: uuid("evaluation_run_id").references(() => evaluationRuns.id, { onDelete: "restrict" }),
  evidenceRef: text("evidence_ref").notNull(),
  manifestFingerprint: text("manifest_fingerprint").notNull(),
  manifest: jsonb("manifest").notNull(),
  modelFamily: text("model_family"),
  modelIdentifier: text("model_identifier"),
  checkpointDigest: text("checkpoint_digest"),
  adapterId: text("adapter_id"),
  adapterDigest: text("adapter_digest"),
  measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
  validity: text("validity").notNull(),
  sampleSize: integer("sample_size").notNull(),
  correctCount: integer("correct_count").notNull(),
  incorrectCount: integer("incorrect_count").notNull(),
  failureClasses: jsonb("failure_classes").$type<Record<string, number>>().notNull(),
  accuracy: doublePrecision("accuracy").notNull(),
  uncertaintyLow: doublePrecision("uncertainty_low").notNull(),
  uncertaintyHigh: doublePrecision("uncertainty_high").notNull(),
  measurementMode: text("measurement_mode").notNull(),
  capabilityKind: text("capability_kind").notNull(),
  items: jsonb("items").notNull(),
  provenance: text("provenance").notNull(),
  schemaVersion: text("schema_version").notNull(),
  certifiedBy: text("certified_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerRetentionEvents = pgTable(
  "ledger_retention_events",
  {
    id: uuid("id").primaryKey(),
    snapshotId: uuid("snapshot_id").notNull().references(() => ledgerSnapshots.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    decidedBy: text("decided_by").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("ledger_retention_events_action_check", textIn("action", ["retain", "revoke", "archive"]))],
);

export const departmentServingInstances = pgTable(
  "department_serving_instances",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    endpointReference: text("endpoint_reference").notNull(),
    normalizedEndpoint: text("normalized_endpoint").notNull(),
    modelRegistryId: uuid("model_registry_id").notNull().references(() => models.id, { onDelete: "restrict" }),
    modelVersion: text("model_version").notNull(),
    artifactDigest: text("artifact_digest"),
    deploymentMode: text("deployment_mode").notNull(),
    status: text("status").notNull(),
    resourcePolicyId: text("resource_policy_id").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("department_serving_instances_department_unique").on(table.departmentId),
    unique("department_serving_instances_endpoint_ref_unique").on(table.endpointReference),
    unique("department_serving_instances_endpoint_unique").on(table.normalizedEndpoint),
    check("department_serving_instances_provider_check", textIn("provider", SERVING_PROVIDERS)),
    check("department_serving_instances_status_check", textIn("status", SERVING_STATUSES)),
    check("department_serving_instances_mode_check", sql`${table.deploymentMode} = 'dedicated'`),
  ],
);

export const departmentServingEvents = pgTable("department_serving_events", {
  id: uuid("id").primaryKey(),
  instanceId: uuid("instance_id").notNull().references(() => departmentServingInstances.id, { onDelete: "restrict" }),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const departmentAgentCheckpoints = pgTable(
  "department_agent_checkpoints",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").notNull(),
    servingInstanceId: uuid("serving_instance_id").notNull().references(() => departmentServingInstances.id, { onDelete: "restrict" }),
    modelVersion: text("model_version").notNull(),
    endpointReference: text("endpoint_reference").notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("department_agent_checkpoints_task_unique").on(table.agentId, table.taskId)],
);

export const productImprovementProposals = pgTable(
  "product_improvement_proposals",
  {
    id: uuid("id").primaryKey(),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    proposedByAgentId: uuid("proposed_by_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    problem: text("problem").notNull(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull(),
    expectedBenefit: text("expected_benefit").notNull(),
    participants: jsonb("participants").$type<unknown[]>().notNull(),
    estimatedCost: text("estimated_cost").notNull(),
    risk: text("risk").notNull(),
    successCriteria: text("success_criteria").notNull(),
    priority: text("priority").notNull(),
    dependencies: jsonb("dependencies").$type<string[]>().notNull(),
    approvalRequirements: jsonb("approval_requirements").$type<string[]>().notNull(),
    recommendsNewDepartment: boolean("recommends_new_department").notNull(),
    status: text("status").notNull(),
    evaluationEvidence: jsonb("evaluation_evidence").$type<Record<string, unknown> | null>(),
    recommendation: text("recommendation"),
    outcome: text("outcome"),
    successful: boolean("successful").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("product_improvement_proposals_status_idx").on(table.status),
    index("product_improvement_proposals_department_idx").on(table.departmentId),
    check(
      "product_improvement_proposals_status_check",
      sql`${table.status} in ('proposed', 'under_review', 'approved', 'in_progress', 'evaluating', 'completed', 'rejected')`,
    ),
    check("product_improvement_proposals_priority_check", sql`${table.priority} in ('low', 'medium', 'high')`),
    check(
      "product_improvement_proposals_recommendation_check",
      sql`${table.recommendation} is null or ${table.recommendation} in ('retain', 'revise', 'revert')`,
    ),
  ],
);

export const productImprovementEvents = pgTable(
  "product_improvement_events",
  {
    id: uuid("id").primaryKey(),
    proposalId: uuid("proposal_id").notNull().references(() => productImprovementProposals.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("product_improvement_events_proposal_idx").on(table.proposalId, table.createdAt)],
);

export const colonyAutonomy = pgTable(
  "colony_autonomy",
  {
    id: text("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    paused: boolean("paused").notNull().default(false),
    intervalMs: integer("interval_ms").notNull(),
    cooldownMs: integer("cooldown_ms").notNull(),
    maxActiveGoals: integer("max_active_goals").notNull(),
    maxInferenceRequests: integer("max_inference_requests").notNull(),
    maxDurationMs: integer("max_duration_ms").notNull(),
    maxConversations: integer("max_conversations").notNull(),
    maxConversationMessages: integer("max_conversation_messages").notNull(),
    maxConversationTokens: integer("max_conversation_tokens").notNull(),
    maxConversationParticipants: integer("max_conversation_participants").notNull().default(12),
    conversationExecutionEnabled: boolean("conversation_execution_enabled").notNull().default(false),
    maxConcurrentConversationTurns: integer("max_concurrent_conversation_turns").notNull().default(1),
    contextTokenBudget: integer("context_token_budget").notNull().default(1500),
    conversationSoftTokenBudget: integer("conversation_soft_token_budget").notNull().default(20_000),
    conversationHardTokenCeiling: integer("conversation_hard_token_ceiling").notNull().default(60_000),
    conversationCheckpointTurns: integer("conversation_checkpoint_turns").notNull().default(10),
    maxInferenceOutputTokens: integer("max_inference_output_tokens").notNull().default(4_000),
    maxInferenceEstimatedTokens: integer("max_inference_estimated_tokens").notNull().default(32_000),
    consumedInferenceRequests: integer("consumed_inference_requests").notNull().default(0),
    reservedInferenceRequests: integer("reserved_inference_requests").notNull().default(0),
    consumedInputTokens: integer("consumed_input_tokens").notNull().default(0),
    consumedOutputTokens: integer("consumed_output_tokens").notNull().default(0),
    estimatedInputTokens: integer("estimated_input_tokens").notNull().default(0),
    estimatedOutputTokens: integer("estimated_output_tokens").notNull().default(0),
    reservedOutputTokens: integer("reserved_output_tokens").notNull().default(0),
    estimatedCostUsdMicros: bigint("estimated_cost_usd_micros", { mode: "number" }),
    lastCycleAt: timestamp("last_cycle_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "colony_autonomy_inference_counters_check",
      sql`${table.consumedInferenceRequests} >= 0
        and ${table.reservedInferenceRequests} >= 0
        and ${table.consumedInputTokens} >= 0
        and ${table.consumedOutputTokens} >= 0
        and ${table.estimatedInputTokens} >= 0
        and ${table.estimatedOutputTokens} >= 0
        and ${table.reservedOutputTokens} >= 0`,
    ),
    check(
      "colony_autonomy_inference_token_limits_check",
      sql`${table.maxInferenceOutputTokens} > 0
        and ${table.maxInferenceEstimatedTokens} > 0
        and ${table.maxInferenceEstimatedTokens} >= ${table.maxInferenceOutputTokens}`,
    ),
  ],
);

export const colonyGoalCycles = pgTable(
  "colony_goal_cycles",
  {
    id: uuid("id").primaryKey(),
    outcome: text("outcome").notNull(),
    rationale: text("rationale").notNull(),
    goalId: uuid("goal_id"),
    prompt: jsonb("prompt").$type<Array<{ role: string; content: string }>>().notNull(),
    responseText: text("response_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("colony_goal_cycles_created_idx").on(table.createdAt)],
);

export const colonyGoals = pgTable(
  "colony_goals",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id").notNull().references(() => objectiveRuns.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    motivation: text("motivation").notNull(),
    evidence: jsonb("evidence").$type<string[]>().notNull(),
    hypotheses: jsonb("hypotheses").$type<string[]>().notNull(),
    expectedBenefit: text("expected_benefit").notNull(),
    successCriteria: jsonb("success_criteria").$type<string[]>().notNull(),
    estimatedInferenceRequests: integer("estimated_inference_requests").notNull(),
    departments: jsonb("departments").$type<string[]>().notNull(),
    priority: text("priority").notNull(),
    stopConditions: jsonb("stop_conditions").$type<string[]>().notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("colony_goals_status_idx").on(table.status, table.createdAt),
    check("colony_goals_status_check", sql`${table.status} in ('selected', 'cancelled', 'completed', 'failed')`),
    check("colony_goals_priority_check", sql`${table.priority} in ('low', 'medium', 'high')`),
  ],
);

export const objectiveSubgoals = pgTable(
  "objective_subgoals",
  {
    id: uuid("id").primaryKey(),
    objectiveId: uuid("objective_id").notNull().references(() => objectiveRuns.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    description: text("description").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("objective_subgoals_key_unique").on(table.idempotencyKey),
    index("objective_subgoals_objective_idx").on(table.objectiveId, table.createdAt),
  ],
);

export const departmentConversations = pgTable(
  "department_conversations",
  {
    id: uuid("id").primaryKey(),
    topic: text("topic").notNull(),
    objectiveId: uuid("objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
    openedByDepartmentId: uuid("opened_by_department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    inferenceRequests: integer("inference_requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    maxMessages: integer("max_messages").notNull(),
    maxTokens: integer("max_tokens").notNull(),
    maxDurationMs: integer("max_duration_ms").notNull(),
    closeReason: text("close_reason"),
    finalConclusion: text("final_conclusion"),
    remainingDisagreements: jsonb("remaining_disagreements").$type<string[]>().notNull().default([]),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    contextSummary: text("context_summary"),
    nextSequence: integer("next_sequence").notNull().default(0),
    outcome: text("outcome"),
    paused: boolean("paused").notNull().default(false),
    runnerStatus: text("runner_status").notNull().default("idle"),
    runnerFence: integer("runner_fence").notNull().default(0),
    runnerLeaseUntil: timestamp("runner_lease_until", { withTimezone: true }),
    parentConversationId: uuid("parent_conversation_id"),
    scheduledSpeakerId: uuid("scheduled_speaker_id"),
    lastError: text("last_error"),
    lastInferenceLatencyMs: integer("last_inference_latency_ms"),
    lastInferenceEndpoint: text("last_inference_endpoint"),
    progressState: jsonb("progress_state").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    openingInstruction: text("opening_instruction"),
    recommendedSpeakerId: uuid("recommended_speaker_id").references(() => departments.id, { onDelete: "restrict" }),
    speakerRecommendationReason: text("speaker_recommendation_reason"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("department_conversations_status_idx").on(table.status, table.openedAt),
    check(
      "department_conversations_status_check",
      sql`${table.status} in ('open', 'resolved', 'unresolved', 'terminated')`,
    ),
    check(
      "department_conversations_runner_check",
      sql`${table.runnerStatus} in ('idle', 'scheduled', 'running', 'paused', 'waiting_on_child', 'stopped')`,
    ),
  ],
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: uuid("conversation_id").notNull().references(() => departmentConversations.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    membership: text("membership").notNull().default("active"),
    invitedByDepartmentId: uuid("invited_by_department_id").references(() => departments.id, { onDelete: "restrict" }),
    joinSequence: integer("join_sequence").notNull().default(0),
    participantRole: text("participant_role").notNull().default("participant"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.departmentId] }),
    check("conversation_participants_membership_check", sql`${table.membership} in ('active', 'invited', 'declined', 'removed')`),
  ],
);

export const conversationMembershipEvents = pgTable(
  "conversation_membership_events",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").notNull().references(() => departmentConversations.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    actorDepartmentId: uuid("actor_department_id").references(() => departments.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("conversation_membership_events_conversation_idx").on(table.conversationId, table.createdAt),
    check("conversation_membership_events_action_check", sql`${table.action} in ('joined', 'invited', 'accepted', 'declined', 'removed')`),
  ],
);

export const conversationTurns = pgTable(
  "conversation_turns",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").notNull().references(() => departmentConversations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull().references(() => iacpMessages.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    addressedDepartmentId: uuid("addressed_department_id").references(() => departments.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull().default(0),
    parentMessageId: uuid("parent_message_id"),
    prompt: jsonb("prompt").$type<Array<{ role: string; content: string }>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("conversation_turns_key_unique").on(table.idempotencyKey),
    index("conversation_turns_conversation_idx").on(table.conversationId, table.createdAt),
  ],
);

export const conversationTurnClaims = pgTable(
  "conversation_turn_claims",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    conversationId: uuid("conversation_id").notNull().references(() => departmentConversations.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    addressedDepartmentId: uuid("addressed_department_id").references(() => departments.id, { onDelete: "restrict" }),
    parentMessageId: uuid("parent_message_id"),
    sequence: integer("sequence").notNull(),
    body: text("body"),
    prompt: jsonb("prompt").$type<Array<{ role: string; content: string }> | null>(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversation_turn_claims_conversation_idx").on(table.conversationId, table.sequence)],
);

export const conversationJobs = pgTable(
  "conversation_jobs",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").notNull().references(() => departmentConversations.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    fence: integer("fence").notNull(),
    status: text("status").notNull(),
    action: text("action").notNull(),
    attempt: integer("attempt").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    speakerDepartmentId: uuid("speaker_department_id").references(() => departments.id, { onDelete: "restrict" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("conversation_jobs_key_unique").on(table.idempotencyKey),
    uniqueIndex("conversation_jobs_one_active").on(table.conversationId).where(sql`${table.status} in ('pending', 'leased')`),
    index("conversation_jobs_status_idx").on(table.status, table.createdAt),
    check("conversation_jobs_status_check", sql`${table.status} in ('pending', 'leased', 'completed', 'dead')`),
    check("conversation_jobs_action_check", sql`${table.action} in ('speak', 'invitation')`),
  ],
);

export const conversationContextEvents = pgTable(
  "conversation_context_events",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").notNull().references(() => departmentConversations.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    query: text("query").notNull(),
    messageIds: jsonb("message_ids").$type<string[]>().notNull(),
    tokens: integer("tokens").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("conversation_context_events_conversation_idx").on(table.conversationId, table.createdAt),
    check("conversation_context_events_kind_check", sql`${table.kind} in ('search', 'summary')`),
  ],
);

const EVIDENCE_ACCEPTANCE = ["accepted", "rejected", "recovered", "failed", "partial"] as const;
const EVIDENCE_FAILURE_CLASSES = [
  "json_invalid",
  "schema_invalid",
  "serialization_error",
  "meta_validation_chatter",
  "repetition",
  "context_missing",
  "orchestration_failure",
  "math_unverified",
  "unsupported_evidence",
  "reasoning_error",
  "inference_timeout",
  "inference_error",
  "unknown",
] as const;
const EVIDENCE_CLASSIFICATION_SOURCES = ["runtime", "human", "evaluation", "system"] as const;
const EVIDENCE_CLASSIFICATION_CONFIDENCE = ["observed", "provisional", "reviewed", "verified"] as const;
const EVIDENCE_ELIGIBILITY = ["not_reviewed", "ineligible", "candidate", "verified_for_dataset"] as const;
const EVIDENCE_CAPTURE = ["captured", "capture_failed", "unavailable"] as const;
const EVIDENCE_CORRECTION_STATUSES = ["unverified", "verified", "rejected"] as const;
const EVIDENCE_CORRECTION_EVENTS = ["proposed", "verified", "rejected", "revised"] as const;

export const trainingInferenceAttempts = pgTable(
  "training_inference_attempts",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => departmentConversations.id, { onDelete: "restrict" }),
    turnId: uuid("turn_id").references(() => conversationTurns.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    modelRegistryId: uuid("model_registry_id").references(() => models.id, { onDelete: "restrict" }),
    modelVersion: text("model_version"),
    adapterId: uuid("adapter_id"),
    adapterVersion: text("adapter_version"),
    inferenceEndpoint: text("inference_endpoint").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    parentAttemptId: uuid("parent_attempt_id").references((): AnyPgColumn => trainingInferenceAttempts.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    promptHash: text("prompt_hash").notNull(),
    promptSnapshot: text("prompt_snapshot"),
    promptTruncated: boolean("prompt_truncated").notNull().default(false),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    rawOutput: text("raw_output"),
    rawOutputHash: text("raw_output_hash").notNull(),
    rawTruncated: boolean("raw_truncated").notNull().default(false),
    rawExpired: boolean("raw_expired").notNull().default(false),
    parsedOutput: jsonb("parsed_output").$type<Record<string, unknown> | null>(),
    validationResult: text("validation_result"),
    acceptanceStatus: text("acceptance_status").notNull(),
    failureClass: text("failure_class"),
    failureSymptom: text("failure_symptom"),
    failureRootCause: text("failure_root_cause"),
    failureProvisional: boolean("failure_provisional").notNull().default(true),
    classificationSource: text("classification_source").notNull().default("runtime"),
    classificationConfidence: text("classification_confidence").notNull().default("observed"),
    classificationEvidence: text("classification_evidence"),
    recoveryOfAttemptId: uuid("recovery_of_attempt_id").references((): AnyPgColumn => trainingInferenceAttempts.id, {
      onDelete: "restrict",
    }),
    trainingEligible: boolean("training_eligible").notNull().default(false),
    eligibilityStatus: text("eligibility_status").notNull().default("not_reviewed"),
    captureStatus: text("capture_status").notNull().default("captured"),
    captureError: text("capture_error"),
  },
  (table) => [
    index("training_inference_attempts_conversation_idx").on(table.conversationId, table.createdAt),
    index("training_inference_attempts_department_idx").on(table.departmentId, table.createdAt),
    index("training_inference_attempts_model_idx").on(table.modelRegistryId, table.createdAt),
    index("training_inference_attempts_failure_idx").on(table.failureClass, table.acceptanceStatus, table.createdAt),
    index("training_inference_attempts_parent_idx").on(table.parentAttemptId),
    check("training_inference_attempts_attempt_number_check", sql`${table.attemptNumber} >= 1`),
    check("training_inference_attempts_latency_check", sql`${table.latencyMs} >= 0`),
    check("training_inference_attempts_acceptance_check", textIn("acceptance_status", EVIDENCE_ACCEPTANCE)),
    check(
      "training_inference_attempts_failure_class_check",
      sql`${table.failureClass} is null or ${textIn("failure_class", EVIDENCE_FAILURE_CLASSES)}`,
    ),
    check("training_inference_attempts_classification_source_check", textIn("classification_source", EVIDENCE_CLASSIFICATION_SOURCES)),
    check(
      "training_inference_attempts_classification_confidence_check",
      textIn("classification_confidence", EVIDENCE_CLASSIFICATION_CONFIDENCE),
    ),
    check("training_inference_attempts_eligibility_status_check", textIn("eligibility_status", EVIDENCE_ELIGIBILITY)),
    check("training_inference_attempts_capture_status_check", textIn("capture_status", EVIDENCE_CAPTURE)),
    check("training_inference_attempts_prompt_hash_check", sql`char_length(${table.promptHash}) = 64`),
    check("training_inference_attempts_raw_hash_check", sql`char_length(${table.rawOutputHash}) = 64`),
    check(
      "training_inference_attempts_eligible_default_check",
      sql`${table.trainingEligible} = false or ${table.eligibilityStatus} = 'verified_for_dataset'`,
    ),
  ],
);

export const trainingEvidenceCorrections = pgTable(
  "training_evidence_corrections",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => trainingInferenceAttempts.id, { onDelete: "restrict" }),
    proposedResponse: text("proposed_response").notNull(),
    artifactRef: text("artifact_ref"),
    authorType: text("author_type").notNull(),
    authorId: text("author_id").notNull(),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    verifierId: text("verifier_id"),
    verificationMethod: text("verification_method"),
    supportingEvidence: text("supporting_evidence"),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "restrict" }),
    modelRegistryId: uuid("model_registry_id").references(() => models.id, { onDelete: "restrict" }),
    taskLabel: text("task_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [
    index("training_evidence_corrections_attempt_idx").on(table.attemptId, table.createdAt),
    check("training_evidence_corrections_author_type_check", sql`${table.authorType} in ('human', 'evaluation', 'system')`),
    check("training_evidence_corrections_status_check", textIn("verification_status", EVIDENCE_CORRECTION_STATUSES)),
    check("training_evidence_corrections_revision_check", sql`${table.revision} >= 1`),
  ],
);

export const trainingEvidenceCorrectionEvents = pgTable(
  "training_evidence_correction_events",
  {
    id: uuid("id").primaryKey(),
    correctionId: uuid("correction_id")
      .notNull()
      .references(() => trainingEvidenceCorrections.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorId: text("actor_id").notNull(),
    method: text("method"),
    evidence: text("evidence"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("training_evidence_correction_events_correction_idx").on(table.correctionId, table.createdAt),
    check("training_evidence_correction_events_type_check", textIn("event_type", EVIDENCE_CORRECTION_EVENTS)),
  ],
);

export const trainingEvidenceEligibilityEvents = pgTable(
  "training_evidence_eligibility_events",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => trainingInferenceAttempts.id, { onDelete: "restrict" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    fromEligible: boolean("from_eligible").notNull(),
    toEligible: boolean("to_eligible").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("training_evidence_eligibility_events_attempt_idx").on(table.attemptId, table.createdAt),
    check("training_evidence_eligibility_events_to_check", textIn("to_status", EVIDENCE_ELIGIBILITY)),
    check(
      "training_evidence_eligibility_events_eligible_check",
      sql`${table.toEligible} = false or ${table.toStatus} = 'verified_for_dataset'`,
    ),
  ],
);

export const trainingEvidenceCaptureFailures = pgTable(
  "training_evidence_capture_failures",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").references(() => departmentConversations.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number"),
    error: text("error").notNull(),
    context: jsonb("context").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("training_evidence_capture_failures_created_idx").on(table.createdAt)],
);

const DEPARTMENT_ROUTING_METHODS = ["deterministic", "model_assisted", "fallback"] as const;
const DEPARTMENT_ROUTING_CONFIDENCE = ["high", "medium", "low"] as const;
const DEPARTMENT_JOIN_STATUSES = ["pending", "approved", "rejected", "failed"] as const;

export const departmentJoinRequests = pgTable(
  "department_join_requests",
  {
    id: uuid("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => departmentConversations.id, { onDelete: "restrict" }),
    requesterDepartmentId: uuid("requester_department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    targetDepartmentId: uuid("target_department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    justification: text("justification").notNull(),
    status: text("status").notNull(),
    decisionRationale: text("decision_rationale"),
    confidence: text("confidence"),
    taskBrief: text("task_brief"),
    inferenceRequestId: uuid("inference_request_id").references(() => inferenceRequests.id, { onDelete: "restrict" }),
    modelMetadata: jsonb("model_metadata").$type<Record<string, unknown> | null>(),
    failureReason: text("failure_reason"),
    createdBy: text("created_by").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("department_join_requests_idempotency_unique").on(table.idempotencyKey),
    index("department_join_requests_conversation_idx").on(table.conversationId, table.createdAt),
    index("department_join_requests_status_idx").on(table.status, table.createdAt),
    check("department_join_requests_status_check", textIn("status", DEPARTMENT_JOIN_STATUSES)),
    check(
      "department_join_requests_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} in ('high', 'medium', 'low')`,
    ),
  ],
);

export const departmentRoutingDecisions = pgTable(
  "department_routing_decisions",
  {
    id: uuid("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    taskText: text("task_text").notNull(),
    objectiveId: uuid("objective_id").references(() => objectiveRuns.id, { onDelete: "restrict" }),
    method: text("method").notNull(),
    primaryDepartmentId: uuid("primary_department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "restrict" }),
    recommendedDepartmentIds: jsonb("recommended_department_ids").$type<string[]>().notNull(),
    rejectedRecommendations: jsonb("rejected_recommendations").$type<Array<Record<string, unknown>>>().notNull(),
    finalParticipantIds: jsonb("final_participant_ids").$type<string[]>().notNull(),
    rationale: text("rationale").notNull(),
    confidence: text("confidence").notNull(),
    uncertainty: text("uncertainty"),
    approvalRequired: boolean("approval_required").notNull().default(false),
    modelMetadata: jsonb("model_metadata").$type<Record<string, unknown> | null>(),
    fallbackReason: text("fallback_reason"),
    createdBy: text("created_by").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("department_routing_decisions_idempotency_unique").on(table.idempotencyKey),
    index("department_routing_decisions_created_idx").on(table.createdAt),
    index("department_routing_decisions_method_idx").on(table.method, table.createdAt),
    check("department_routing_decisions_method_check", textIn("method", DEPARTMENT_ROUTING_METHODS)),
    check("department_routing_decisions_confidence_check", textIn("confidence", DEPARTMENT_ROUTING_CONFIDENCE)),
  ],
);
