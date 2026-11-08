import { desc, eq } from "drizzle-orm";
import type { DepartmentJoinRequestRecord, DepartmentJoinRequestRepository } from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import { departmentJoinRequests } from "../schema/index.js";

export function createDepartmentJoinRequestRepository(db: DbExecutor): DepartmentJoinRequestRepository {
  return {
    async insert(row) {
      return guard(async () => {
        const [saved] = await db
          .insert(departmentJoinRequests)
          .values({
            id: row.id,
            idempotencyKey: row.idempotencyKey,
            conversationId: row.conversationId,
            requesterDepartmentId: row.requesterDepartmentId,
            targetDepartmentId: row.targetDepartmentId,
            justification: row.justification,
            status: row.status,
            decisionRationale: row.decisionRationale,
            confidence: row.confidence,
            taskBrief: row.taskBrief,
            inferenceRequestId: row.inferenceRequestId,
            modelMetadata: row.modelMetadata,
            failureReason: row.failureReason,
            createdBy: row.createdBy,
            correlationId: row.correlationId,
            createdAt: new Date(row.createdAt),
            decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
          })
          .returning();
        if (!saved) {
          throw new Error("department_join_requests insert returned no row");
        }
        return mapRow(saved);
      });
    },

    async findByIdempotencyKey(key) {
      return guard(async () => {
        const [row] = await db
          .select()
          .from(departmentJoinRequests)
          .where(eq(departmentJoinRequests.idempotencyKey, key))
          .limit(1);
        return row ? mapRow(row) : null;
      });
    },

    async findById(id) {
      return guard(async () => {
        const [row] = await db
          .select()
          .from(departmentJoinRequests)
          .where(eq(departmentJoinRequests.id, id))
          .limit(1);
        return row ? mapRow(row) : null;
      });
    },

    async listByConversation(conversationId, limit = 50) {
      return guard(async () => {
        const rows = await db
          .select()
          .from(departmentJoinRequests)
          .where(eq(departmentJoinRequests.conversationId, conversationId))
          .orderBy(desc(departmentJoinRequests.createdAt))
          .limit(limit);
        return rows.map(mapRow);
      });
    },
  };
}

function mapRow(row: typeof departmentJoinRequests.$inferSelect): DepartmentJoinRequestRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    conversationId: row.conversationId,
    requesterDepartmentId: row.requesterDepartmentId,
    targetDepartmentId: row.targetDepartmentId,
    justification: row.justification,
    status: row.status as DepartmentJoinRequestRecord["status"],
    decisionRationale: row.decisionRationale,
    confidence: row.confidence as DepartmentJoinRequestRecord["confidence"],
    taskBrief: row.taskBrief,
    inferenceRequestId: row.inferenceRequestId,
    modelMetadata: row.modelMetadata,
    failureReason: row.failureReason,
    createdBy: row.createdBy,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}
