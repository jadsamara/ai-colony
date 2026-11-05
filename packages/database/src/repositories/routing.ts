import { and, eq, isNull } from "drizzle-orm";
import type { RoutingRepository, StoredRoutingDecision } from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import { routingDecisions } from "../schema/index.js";

export function createRoutingRepository(db: DbExecutor): RoutingRepository {
  return {
    async insert(row) {
      await guard(() => db.insert(routingDecisions).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async findByTask(taskId) {
      const [row] = await db.select().from(routingDecisions).where(eq(routingDecisions.taskId, taskId)).limit(1);
      return row ? mapDecision(row) : null;
    },
    async findByObjectivePurpose(objectiveId, purpose) {
      const [row] = await db
        .select()
        .from(routingDecisions)
        .where(and(eq(routingDecisions.objectiveId, objectiveId), eq(routingDecisions.purpose, purpose), isNull(routingDecisions.taskId)))
        .limit(1);
      return row ? mapDecision(row) : null;
    },
  };
}

function mapDecision(row: typeof routingDecisions.$inferSelect): StoredRoutingDecision {
  return {
    id: row.id,
    taskId: row.taskId,
    objectiveId: row.objectiveId,
    purpose: row.purpose,
    departmentId: row.departmentId,
    assignmentId: row.assignmentId,
    assignmentVersion: row.assignmentVersion,
    registryModelId: row.registryModelId,
    servingModel: row.servingModel,
    modelDigest: row.modelDigest,
    adapterId: row.adapterId,
    adapterVersion: row.adapterVersion,
    policyVersion: row.policyVersion,
    authorization: row.authorization === "authorized" ? "authorized" : "denied",
    reasonCode: row.reasonCode,
    budgetOutcome: row.budgetOutcome,
    resourceOutcome: row.resourceOutcome,
    fallbackStatus: "disabled",
    executionVerification: row.executionVerification === "matched" || row.executionVerification === "mismatch" ? row.executionVerification : "unverified",
    capabilityNote: row.capabilityNote,
    runtimeEvidence: row.runtimeEvidence,
    createdAt: row.createdAt.toISOString(),
    servingInstanceId: row.servingInstanceId,
    endpointReference: row.endpointReference,
    agentId: row.agentId,
    servingPolicyVersion: row.servingPolicyVersion,
  };
}
