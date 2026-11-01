import { z } from "zod";
import { PRINCIPAL_TYPES } from "../constants.js";
import { pageSchema, paginationQuerySchema, uuidSchema } from "./common.js";
import { roleNameSchema } from "./agent.js";

export const principalTypeSchema = z.enum(PRINCIPAL_TYPES);

export const actorSchema = z.object({
  principalId: z.string().min(1),
  principalType: principalTypeSchema,
  role: roleNameSchema,
  agentId: uuidSchema.nullable(),
  departmentId: uuidSchema.nullable(),
  permissions: z.array(z.string()),
});

export const auditEventSchema = z.object({
  eventId: uuidSchema,
  eventType: z.string(),
  actorId: z.string(),
  actorType: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  action: z.string(),
  timestamp: z.string().datetime(),
  correlationId: z.string(),
  beforeState: z.record(z.string(), z.unknown()).nullable(),
  afterState: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const auditListQuerySchema = paginationQuerySchema.extend({
  targetType: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(128).optional(),
  eventType: z.string().min(1).max(128).optional(),
});

export const auditListResponseSchema = pageSchema(auditEventSchema);
export const meResponseSchema = z.object({ principal: actorSchema });

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    correlationId: z.string(),
  }),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("ai-colony-api"),
  checks: z
    .object({
      database: z.enum(["ok", "down"]),
    })
    .optional(),
});

export type Actor = z.infer<typeof actorSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export type PrincipalType = z.infer<typeof principalTypeSchema>;
