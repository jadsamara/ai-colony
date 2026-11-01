import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ParameterBudget, ResourceBudget } from "@ai-colony/contracts";
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("objective_runs_status_idx").on(table.status, table.createdAt),
    index("objective_runs_submitter_idx").on(table.submitterPrincipalId, table.createdAt),
    check("objective_runs_status_check", textIn("status", OBJECTIVE_STATUSES)),
    check("objective_runs_profile_check", sql`${table.memoryProfile} in ('shared', 'split')`),
    check("objective_runs_limits_check", sql`${table.maxInferenceRequests} > 0`),
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
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectiveRuns.id, { onDelete: "restrict" }),
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
    check("inference_requests_status_check", textIn("status", INFERENCE_REQUEST_STATUSES)),
    check(
      "inference_requests_purpose_check",
      sql`${table.purpose} in ('plan', 'correct', 'specialist', 'synthesize', 'monitor')`,
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
