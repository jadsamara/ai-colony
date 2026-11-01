import { z } from "zod";
import {
  ADDRESSING_MODES,
  IACP_PAYLOAD_SCHEMA_VERSION,
  IACP_PROTOCOL_VERSION,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
} from "../constants.js";
import { metadataSchema, pageSchema, paginationQuerySchema, uuidSchema } from "./common.js";

export const messageTypeSchema = z.enum(MESSAGE_TYPES);
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export const addressingModeSchema = z.enum(ADDRESSING_MODES);
export const protocolVersionSchema = z.literal(IACP_PROTOCOL_VERSION);
export const payloadSchemaVersionSchema = z.literal(IACP_PAYLOAD_SCHEMA_VERSION);

const text = (max: number) => z.string().min(1).max(max);
const references = z.array(z.string().min(1).max(512)).max(20);
const optionalDeadline = z.string().datetime({ offset: true }).nullable();

export const taskRequestPayloadSchema = z
  .object({
    taskId: uuidSchema,
    objective: text(4000),
    constraints: z.array(text(500)).max(20),
    expectedOutput: text(4000),
    deadline: optionalDeadline,
    contextReferences: references,
  })
  .strict();

export const taskResultPayloadSchema = z
  .object({
    taskId: uuidSchema,
    status: z.enum(["recorded", "declined", "blocked"]),
    summary: text(4000),
    artifactReferences: references,
  })
  .strict();

export const collaborationRequestPayloadSchema = z
  .object({
    subject: text(200),
    objective: text(4000),
    requestedContribution: text(2000),
    deadline: optionalDeadline,
  })
  .strict();

export const knowledgeSharePayloadSchema = z
  .object({
    title: text(200),
    summary: text(8000),
    sourceReferences: references,
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const trainingRequestPayloadSchema = z
  .object({
    targetModelId: uuidSchema,
    learningObjective: text(4000),
    datasetReference: text(512),
    trainingConstraints: z
      .object({
        maxParameterCount: z.number().int().nonnegative(),
        notes: z.string().max(2000),
      })
      .strict(),
    evaluationRequirements: z.array(text(500)).max(20),
  })
  .strict();

export const modelCandidatePayloadSchema = z
  .object({
    modelId: uuidSchema,
    candidateVersion: text(64),
    artifactUri: z.string().min(1).max(512).nullable(),
    summary: text(4000),
    proposedStatus: z.enum(["registered", "not_deployed"]),
  })
  .strict();

export const evaluationResultPayloadSchema = z
  .object({
    subjectType: z.enum(["model", "agent", "department", "message"]),
    subjectId: uuidSchema,
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    metrics: z.record(z.string().min(1).max(64), z.number().finite()),
    notes: z.string().max(4000),
  })
  .strict();

export const resourceRequestPayloadSchema = z
  .object({
    resource: z.enum(["cpu", "gpu", "memory", "compute_budget", "training_budget"]),
    amount: z.number().nonnegative().finite(),
    unit: text(32),
    justification: text(4000),
    neededBy: optionalDeadline,
  })
  .strict();

export const healthAlertPayloadSchema = z
  .object({
    severity: z.enum(["info", "warning", "critical"]),
    component: text(128),
    summary: text(4000),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const evolutionProposalPayloadSchema = z
  .object({
    proposalType: z.enum([
      "new_department",
      "restructure",
      "retire_department",
      "specialize_agent",
    ]),
    objective: text(4000),
    affectedDepartments: z.array(uuidSchema).min(1).max(20),
    expectedBenefit: text(4000),
    requiredResources: text(2000),
    evaluationCriteria: z.array(text(500)).min(1).max(20),
  })
  .strict();

export const payloadSchemaByType = {
  TASK_REQUEST: taskRequestPayloadSchema,
  TASK_RESULT: taskResultPayloadSchema,
  COLLABORATION_REQUEST: collaborationRequestPayloadSchema,
  KNOWLEDGE_SHARE: knowledgeSharePayloadSchema,
  TRAINING_REQUEST: trainingRequestPayloadSchema,
  MODEL_CANDIDATE: modelCandidatePayloadSchema,
  EVALUATION_RESULT: evaluationResultPayloadSchema,
  RESOURCE_REQUEST: resourceRequestPayloadSchema,
  HEALTH_ALERT: healthAlertPayloadSchema,
  EVOLUTION_PROPOSAL: evolutionProposalPayloadSchema,
} as const;

const messageFields = {
  messageId: uuidSchema,
  protocolVersion: protocolVersionSchema,
  senderAgentId: uuidSchema,
  senderDepartmentId: uuidSchema,
  recipientAgentId: uuidSchema.nullable(),
  recipientDepartmentId: uuidSchema.nullable(),
  addressingMode: addressingModeSchema,
  inboxDepartmentId: uuidSchema,
  correlationId: uuidSchema,
  causationId: uuidSchema.nullable(),
  replyToMessageId: uuidSchema.nullable(),
  priority: z.number().int().min(0).max(9),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  payloadSchemaVersion: payloadSchemaVersionSchema,
  idempotencyKey: z.string().nullable(),
  metadata: metadataSchema,
  status: messageStatusSchema,
  updatedAt: z.string().datetime(),
};

function envelope<T extends z.infer<typeof messageTypeSchema>, P extends z.ZodTypeAny>(
  messageType: T,
  payload: P,
) {
  return z.object({ ...messageFields, messageType: z.literal(messageType), payload }).strict();
}

export const messageSchema = z.discriminatedUnion("messageType", [
  envelope("TASK_REQUEST", taskRequestPayloadSchema),
  envelope("TASK_RESULT", taskResultPayloadSchema),
  envelope("COLLABORATION_REQUEST", collaborationRequestPayloadSchema),
  envelope("KNOWLEDGE_SHARE", knowledgeSharePayloadSchema),
  envelope("TRAINING_REQUEST", trainingRequestPayloadSchema),
  envelope("MODEL_CANDIDATE", modelCandidatePayloadSchema),
  envelope("EVALUATION_RESULT", evaluationResultPayloadSchema),
  envelope("RESOURCE_REQUEST", resourceRequestPayloadSchema),
  envelope("HEALTH_ALERT", healthAlertPayloadSchema),
  envelope("EVOLUTION_PROPOSAL", evolutionProposalPayloadSchema),
]);

export const messagePublishSchema = z
  .object({
    messageType: messageTypeSchema,
    recipientAgentId: uuidSchema.nullable().optional(),
    recipientDepartmentId: uuidSchema.nullable().optional(),
    correlationId: uuidSchema.optional(),
    causationId: uuidSchema.nullable().optional(),
    replyToMessageId: uuidSchema.nullable().optional(),
    priority: z.number().int().min(0).max(9).default(5),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    payload: z.unknown(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{8,128}$/)
      .nullable()
      .optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasAgent = value.recipientAgentId != null;
    const hasDepartment = value.recipientDepartmentId != null;
    if (hasAgent === hasDepartment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set exactly one of recipientAgentId or recipientDepartmentId",
        path: ["recipientAgentId"],
      });
    }
  });

export const taskRequestPublishSchema = messagePublishSchema.and(
  z.object({ messageType: z.literal("TASK_REQUEST"), payload: taskRequestPayloadSchema }).strict(),
);

export const knowledgePublishSchema = messagePublishSchema.and(
  z.object({ messageType: z.literal("KNOWLEDGE_SHARE"), payload: knowledgeSharePayloadSchema }).strict(),
);

export const collaborationPublishSchema = messagePublishSchema.and(
  z
    .object({
      messageType: z.literal("COLLABORATION_REQUEST"),
      payload: collaborationRequestPayloadSchema,
    })
    .strict(),
);

export const messageRejectSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const messageListQuerySchema = paginationQuerySchema.extend({
  messageType: messageTypeSchema.optional(),
  status: messageStatusSchema.optional(),
  correlationId: uuidSchema.optional(),
  inbox: z.enum(["agent", "department", "sent"]).optional(),
});

export const messageResponseSchema = z.object({
  message: messageSchema,
  replayed: z.boolean(),
});

export const messageGetResponseSchema = z.object({
  message: messageSchema,
});

export const messageListResponseSchema = pageSchema(messageSchema);

export const outboxStateSchema = z.object({
  outboxId: uuidSchema,
  attempt: z.number().int().positive(),
  status: z.enum(["pending", "publishing", "published", "failed"]),
  publishAttempts: z.number().int().nonnegative(),
  availableAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const processingStateSchema = z.object({
  status: z.enum([
    "processing",
    "recorded",
    "acknowledged",
    "rejected",
    "expired",
    "dead_lettered",
    "retry_scheduled",
  ]),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const deadLetterStateSchema = z.object({
  deadLetterId: uuidSchema,
  reason: z.string(),
  detail: z.string(),
  attemptCount: z.number().int().nonnegative(),
  status: z.enum(["open", "redriven"]),
  createdAt: z.string().datetime(),
});

export const messageStatusResponseSchema = z.object({
  message: messageSchema,
  outbox: z.array(outboxStateSchema),
  processing: processingStateSchema.nullable(),
  deadLetter: deadLetterStateSchema.nullable(),
});

export const deadLetterListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["open", "redriven"]).optional(),
});

export const deadLetterSchema = deadLetterStateSchema.extend({
  messageId: uuidSchema.nullable(),
  messageType: messageTypeSchema.nullable(),
});

export const deadLetterListResponseSchema = pageSchema(deadLetterSchema);

export const deadLetterRedriveResponseSchema = z.object({
  deadLetter: deadLetterSchema,
  message: messageSchema,
});

export const messagingMetricsSchema = z.object({
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    publishing: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  processing: z.object({
    recorded: z.number().int().nonnegative(),
    retryScheduled: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative(),
  }),
  deadLettersOpen: z.number().int().nonnegative(),
  oldestPendingAgeMs: z.number().int().nonnegative().nullable(),
  deliveryGuarantee: z.literal("at-least-once"),
});

export type MessageType = z.infer<typeof messageTypeSchema>;
export type MessageStatus = z.infer<typeof messageStatusSchema>;
export type AddressingMode = z.infer<typeof addressingModeSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessagePublish = z.infer<typeof messagePublishSchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
export type DeadLetter = z.infer<typeof deadLetterSchema>;
export type DeadLetterListQuery = z.infer<typeof deadLetterListQuerySchema>;
export type MessagingMetrics = z.infer<typeof messagingMetricsSchema>;
export type MessageStatusView = z.infer<typeof messageStatusResponseSchema>;
