import { desc, eq } from "drizzle-orm";
import type { DepartmentRoutingDecisionRecord, DepartmentRoutingRepository } from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import { departmentRoutingDecisions } from "../schema/index.js";

export function createDepartmentRoutingRepository(db: DbExecutor): DepartmentRoutingRepository {
  return {
    async insert(row) {
      return guard(async () => {
        const [saved] = await db
          .insert(departmentRoutingDecisions)
          .values({
            id: row.id,
            idempotencyKey: row.idempotencyKey,
            taskText: row.taskText,
            objectiveId: row.objectiveId,
            method: row.method,
            primaryDepartmentId: row.primaryDepartmentId,
            recommendedDepartmentIds: row.recommendedDepartmentIds,
            rejectedRecommendations: row.rejectedRecommendations,
            finalParticipantIds: row.finalParticipantIds,
            rationale: row.rationale,
            confidence: row.confidence,
            uncertainty: row.uncertainty,
            approvalRequired: row.approvalRequired,
            modelMetadata: row.modelMetadata,
            fallbackReason: row.fallbackReason,
            createdBy: row.createdBy,
            correlationId: row.correlationId,
            createdAt: new Date(row.createdAt),
          })
          .returning();
        if (!saved) {
          throw new Error("department_routing_decisions insert returned no row");
        }
        return mapRow(saved);
      });
    },

    async findByIdempotencyKey(key) {
      return guard(async () => {
        const [row] = await db
          .select()
          .from(departmentRoutingDecisions)
          .where(eq(departmentRoutingDecisions.idempotencyKey, key))
          .limit(1);
        return row ? mapRow(row) : null;
      });
    },

    async findById(id) {
      return guard(async () => {
        const [row] = await db
          .select()
          .from(departmentRoutingDecisions)
          .where(eq(departmentRoutingDecisions.id, id))
          .limit(1);
        return row ? mapRow(row) : null;
      });
    },

    async listRecent(limit) {
      return guard(async () => {
        const rows = await db
          .select()
          .from(departmentRoutingDecisions)
          .orderBy(desc(departmentRoutingDecisions.createdAt))
          .limit(limit);
        return rows.map(mapRow);
      });
    },
  };
}

function mapRow(row: typeof departmentRoutingDecisions.$inferSelect): DepartmentRoutingDecisionRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    taskText: row.taskText,
    objectiveId: row.objectiveId,
    method: row.method as DepartmentRoutingDecisionRecord["method"],
    primaryDepartmentId: row.primaryDepartmentId,
    recommendedDepartmentIds: row.recommendedDepartmentIds,
    rejectedRecommendations: row.rejectedRecommendations,
    finalParticipantIds: row.finalParticipantIds,
    rationale: row.rationale,
    confidence: row.confidence as DepartmentRoutingDecisionRecord["confidence"],
    uncertainty: row.uncertainty,
    approvalRequired: row.approvalRequired,
    modelMetadata: row.modelMetadata,
    fallbackReason: row.fallbackReason,
    createdBy: row.createdBy,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  };
}
