import { and, eq, isNotNull, lte, ne, sql } from "drizzle-orm";
import type {
  AssignmentRecord,
  CapabilityRecord,
  CapabilityVersionRecord,
  CollaborationContextRecord,
  CollaborationEntryRecord,
  CollaborationParticipantRecord,
  DeploymentDecisionRecord,
  GapRecord,
  ImprovementDecisionRecord,
  LearningCycleRecord,
  LearningObjectiveRecord,
  LearningRepository,
  MemoryOwnershipRecord,
  OutcomeRecord,
  TransferRecord,
  ValidationRecord,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import {
  capabilityGaps,
  departmentCapabilities,
  departmentCapabilityVersions,
  departmentModelAssignments,
  knowledgeTransfers,
  knowledgeValidations,
  collaborationContexts,
  collaborationEntries,
  collaborationParticipants,
  deploymentDecisions,
  improvementDecisions,
  learningBudgets,
  learningCycleEvents,
  learningCycles,
  learningObjectives,
  learningOutcomes,
  memoryOwnership,
} from "../schema/index.js";

function at(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function createLearningRepository(db: DbExecutor): LearningRepository {
  return {
    async insertCapability(row) {
      await db.insert(departmentCapabilities).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findCapability(id) {
      const rows = await db.select().from(departmentCapabilities).where(eq(departmentCapabilities.id, id)).limit(1);
      return rows[0] ? mapCapability(rows[0]) : null;
    },
    async findCapabilityBySlug(departmentId, slug) {
      const rows = await db.select().from(departmentCapabilities).where(and(eq(departmentCapabilities.departmentId, departmentId), eq(departmentCapabilities.slug, slug))).limit(1);
      return rows[0] ? mapCapability(rows[0]) : null;
    },
    async listCapabilities(departmentId) {
      const rows = departmentId
        ? await db.select().from(departmentCapabilities).where(eq(departmentCapabilities.departmentId, departmentId))
        : await db.select().from(departmentCapabilities);
      return rows.map(mapCapability);
    },
    async insertCapabilityVersion(row) {
      await db.insert(departmentCapabilityVersions).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async listCapabilityVersions(capabilityId) {
      const rows = await db.select().from(departmentCapabilityVersions).where(eq(departmentCapabilityVersions.capabilityId, capabilityId));
      return rows.map(mapVersion);
    },
    async insertGap(row) {
      await db.insert(capabilityGaps).values({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) });
    },
    async findGap(id) {
      const rows = await db.select().from(capabilityGaps).where(eq(capabilityGaps.id, id)).limit(1);
      return rows[0] ? mapGap(rows[0]) : null;
    },
    async findGapByFingerprint(departmentId, fingerprint) {
      const rows = await db.select().from(capabilityGaps).where(and(eq(capabilityGaps.departmentId, departmentId), eq(capabilityGaps.fingerprint, fingerprint))).limit(1);
      return rows[0] ? mapGap(rows[0]) : null;
    },
    async updateGap(id, patch) {
      await db.update(capabilityGaps).set({ ...patch, updatedAt: patch.updatedAt ? new Date(patch.updatedAt) : undefined }).where(eq(capabilityGaps.id, id));
    },
    async listGaps(departmentId) {
      const rows = departmentId ? await db.select().from(capabilityGaps).where(eq(capabilityGaps.departmentId, departmentId)) : await db.select().from(capabilityGaps);
      return rows.map(mapGap);
    },
    async insertObjective(row) {
      await db.insert(learningObjectives).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findObjective(id) {
      const rows = await db.select().from(learningObjectives).where(eq(learningObjectives.id, id)).limit(1);
      return rows[0] ? mapObjective(rows[0]) : null;
    },
    async listObjectives(departmentId) {
      const rows = departmentId ? await db.select().from(learningObjectives).where(eq(learningObjectives.departmentId, departmentId)) : await db.select().from(learningObjectives);
      return rows.map(mapObjective);
    },
    async insertCycle(row) {
      await db.insert(learningCycles).values({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) });
    },
    async findCycle(id) {
      const rows = await db.select().from(learningCycles).where(eq(learningCycles.id, id)).limit(1);
      return rows[0] ? mapCycle(rows[0]) : null;
    },
    async findCycleByKey(key) {
      const rows = await db.select().from(learningCycles).where(eq(learningCycles.idempotencyKey, key)).limit(1);
      return rows[0] ? mapCycle(rows[0]) : null;
    },
    async updateCycle(id, patch) {
      const { createdAt: _createdAt, ...rest } = patch;
      await db.update(learningCycles).set({ ...rest, updatedAt: rest.updatedAt ? new Date(rest.updatedAt) : new Date() }).where(eq(learningCycles.id, id));
    },
    async listCycles(departmentId) {
      const rows = departmentId ? await db.select().from(learningCycles).where(eq(learningCycles.departmentId, departmentId)) : await db.select().from(learningCycles);
      return rows.map(mapCycle);
    },
    async countExecutingLora(exceptId) {
      const filters = [eq(learningCycles.status, "EXECUTING"), eq(learningCycles.method, "lora")];
      const rows = await db.select({ n: sql<number>`count(*)::int` }).from(learningCycles).where(exceptId ? and(...filters, ne(learningCycles.id, exceptId)) : and(...filters));
      return Number(rows[0]?.n ?? 0);
    },
    async insertEvent(row) {
      await db.insert(learningCycleEvents).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async listEvents(cycleId) {
      const rows = await db.select().from(learningCycleEvents).where(eq(learningCycleEvents.cycleId, cycleId));
      return rows.map((row) => ({ ...row, createdAt: at(row.createdAt) }));
    },
    async insertAssignment(row) {
      await db.insert(departmentModelAssignments).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async listAssignments(departmentId) {
      const rows = await db.select().from(departmentModelAssignments).where(eq(departmentModelAssignments.departmentId, departmentId));
      return rows.map(mapAssignment);
    },
    async supersedeAssignments(departmentId) {
      await db.update(departmentModelAssignments).set({ status: "superseded" }).where(and(eq(departmentModelAssignments.departmentId, departmentId), eq(departmentModelAssignments.status, "active")));
    },
    async insertTransfer(row) {
      await db.insert(knowledgeTransfers).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findTransfer(id) {
      const rows = await db.select().from(knowledgeTransfers).where(eq(knowledgeTransfers.id, id)).limit(1);
      return rows[0] ? mapTransfer(rows[0]) : null;
    },
    async findTransferByKey(key) {
      const rows = await db.select().from(knowledgeTransfers).where(eq(knowledgeTransfers.idempotencyKey, key)).limit(1);
      return rows[0] ? mapTransfer(rows[0]) : null;
    },
    async updateTransfer(id, patch) {
      await db.update(knowledgeTransfers).set(patch).where(eq(knowledgeTransfers.id, id));
    },
    async listTransfers() {
      return (await db.select().from(knowledgeTransfers)).map(mapTransfer);
    },
    async insertValidation(row) {
      await db.insert(knowledgeValidations).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findValidation(transferId) {
      const rows = await db.select().from(knowledgeValidations).where(eq(knowledgeValidations.transferId, transferId)).limit(1);
      return rows[0] ? { ...rows[0], decision: rows[0].decision as ValidationRecord["decision"], createdAt: at(rows[0].createdAt) } : null;
    },
    async insertOutcome(row) {
      await db.insert(learningOutcomes).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findOutcome(cycleId) {
      const rows = await db.select().from(learningOutcomes).where(eq(learningOutcomes.cycleId, cycleId)).limit(1);
      return rows[0] ? { ...rows[0], kind: rows[0].kind as OutcomeRecord["kind"], createdAt: at(rows[0].createdAt) } : null;
    },
    async insertBudget(row) {
      await db.insert(learningBudgets).values(row);
    },
    async findBudget(cycleId) {
      const rows = await db.select().from(learningBudgets).where(eq(learningBudgets.cycleId, cycleId)).limit(1);
      return rows[0] ?? null;
    },
    async updateBudget(cycleId, patch) {
      await db.update(learningBudgets).set(patch).where(eq(learningBudgets.cycleId, cycleId));
    },
    async insertImprovement(row) {
      await db.insert(improvementDecisions).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findImprovement(evaluationRunId, policyVersion) {
      const rows = await db.select().from(improvementDecisions).where(and(eq(improvementDecisions.evaluationRunId, evaluationRunId), eq(improvementDecisions.policyVersion, policyVersion))).limit(1);
      return rows[0] ? mapImprovement(rows[0]) : null;
    },
    async listImprovements(cycleId) {
      return (await db.select().from(improvementDecisions).where(eq(improvementDecisions.cycleId, cycleId))).map(mapImprovement);
    },
    async insertDeployment(row) {
      await db.insert(deploymentDecisions).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findDeployment(cycleId, purpose) {
      const rows = await db.select().from(deploymentDecisions).where(and(eq(deploymentDecisions.cycleId, cycleId), eq(deploymentDecisions.purpose, purpose))).limit(1);
      return rows[0] ? mapDeployment(rows[0]) : null;
    },
    async insertContext(row) {
      await db.insert(collaborationContexts).values({ ...row, expiresAt: row.expiresAt ? new Date(row.expiresAt) : null, createdAt: new Date(row.createdAt), closedAt: row.closedAt ? new Date(row.closedAt) : null });
    },
    async findContext(id) {
      const rows = await db.select().from(collaborationContexts).where(eq(collaborationContexts.id, id)).limit(1);
      return rows[0] ? mapContext(rows[0]) : null;
    },
    async findContextByKey(key) {
      const rows = await db.select().from(collaborationContexts).where(eq(collaborationContexts.idempotencyKey, key)).limit(1);
      return rows[0] ? mapContext(rows[0]) : null;
    },
    async updateContext(id, patch) {
      await db.update(collaborationContexts).set({ ...patch, closedAt: patch.closedAt ? new Date(patch.closedAt) : undefined }).where(eq(collaborationContexts.id, id));
    },
    async insertParticipant(row) {
      await db.insert(collaborationParticipants).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async listParticipants(contextId) {
      return (await db.select().from(collaborationParticipants).where(eq(collaborationParticipants.contextId, contextId))).map(mapParticipant);
    },
    async updateParticipant(id, status) {
      await db.update(collaborationParticipants).set({ status }).where(eq(collaborationParticipants.id, id));
    },
    async insertEntry(row) {
      await db.insert(collaborationEntries).values({ ...row, expiresAt: row.expiresAt ? new Date(row.expiresAt) : null, createdAt: new Date(row.createdAt) });
    },
    async findEntry(id) {
      const rows = await db.select().from(collaborationEntries).where(eq(collaborationEntries.id, id)).limit(1);
      return rows[0] ? mapEntry(rows[0]) : null;
    },
    async findEntryByKey(key) {
      const rows = await db.select().from(collaborationEntries).where(eq(collaborationEntries.idempotencyKey, key)).limit(1);
      return rows[0] ? mapEntry(rows[0]) : null;
    },
    async listEntries(contextId) {
      return (await db.select().from(collaborationEntries).where(eq(collaborationEntries.contextId, contextId))).map(mapEntry);
    },
    async updateEntry(id, patch) {
      await db.update(collaborationEntries).set(patch).where(eq(collaborationEntries.id, id));
    },
    async expireDue(nowIso) {
      const now = new Date(nowIso);
      const entries = await db.update(collaborationEntries).set({ status: "expired" }).where(and(eq(collaborationEntries.status, "active"), isNotNull(collaborationEntries.expiresAt), lte(collaborationEntries.expiresAt, now))).returning({ id: collaborationEntries.id });
      const contexts = await db.update(collaborationContexts).set({ status: "expired", closedAt: now }).where(and(eq(collaborationContexts.status, "open"), isNotNull(collaborationContexts.expiresAt), lte(collaborationContexts.expiresAt, now))).returning({ id: collaborationContexts.id });
      return { entries: entries.length, contexts: contexts.length };
    },
    async insertOwnership(row) {
      await db.insert(memoryOwnership).values({ ...row, createdAt: new Date(row.createdAt) });
    },
    async findOwnership(memoryId) {
      const rows = await db.select().from(memoryOwnership).where(eq(memoryOwnership.memoryId, memoryId)).limit(1);
      return rows[0] ? mapOwnership(rows[0]) : null;
    },
    async listOwnership() {
      return (await db.select().from(memoryOwnership)).map(mapOwnership);
    },
  };
}

function mapCapability(row: typeof departmentCapabilities.$inferSelect): CapabilityRecord {
  return { ...row, createdAt: at(row.createdAt) };
}

function mapVersion(row: typeof departmentCapabilityVersions.$inferSelect): CapabilityVersionRecord {
  return {
    ...row,
    status: row.status as CapabilityVersionRecord["status"],
    improvementKind: row.improvementKind as CapabilityVersionRecord["improvementKind"],
    createdAt: at(row.createdAt),
  };
}

function mapGap(row: typeof capabilityGaps.$inferSelect): GapRecord {
  return {
    ...row,
    severity: row.severity as GapRecord["severity"],
    proposedMethod: row.proposedMethod as GapRecord["proposedMethod"],
    status: row.status as GapRecord["status"],
    createdAt: at(row.createdAt),
    updatedAt: at(row.updatedAt),
  };
}

function mapObjective(row: typeof learningObjectives.$inferSelect): LearningObjectiveRecord {
  return { ...row, mechanism: row.mechanism as LearningObjectiveRecord["mechanism"], createdAt: at(row.createdAt) };
}

function mapCycle(row: typeof learningCycles.$inferSelect): LearningCycleRecord {
  return {
    ...row,
    status: row.status as LearningCycleRecord["status"],
    method: row.method as LearningCycleRecord["method"],
    outcomeKind: row.outcomeKind as LearningCycleRecord["outcomeKind"],
    createdAt: at(row.createdAt),
    updatedAt: at(row.updatedAt),
  };
}

function mapAssignment(row: typeof departmentModelAssignments.$inferSelect): AssignmentRecord {
  return { ...row, role: row.role as AssignmentRecord["role"], status: row.status as AssignmentRecord["status"], createdAt: at(row.createdAt) };
}

function mapTransfer(row: typeof knowledgeTransfers.$inferSelect): TransferRecord {
  return { ...row, status: row.status as TransferRecord["status"], createdAt: at(row.createdAt) };
}

function mapImprovement(row: typeof improvementDecisions.$inferSelect): ImprovementDecisionRecord {
  return {
    ...row,
    classification: row.classification as ImprovementDecisionRecord["classification"],
    deploymentEligibility: row.deploymentEligibility as ImprovementDecisionRecord["deploymentEligibility"],
    createdAt: at(row.createdAt),
  };
}

function mapDeployment(row: typeof deploymentDecisions.$inferSelect): DeploymentDecisionRecord {
  return {
    ...row,
    purpose: row.purpose as DeploymentDecisionRecord["purpose"],
    eligibility: row.eligibility as DeploymentDecisionRecord["eligibility"],
    createdAt: at(row.createdAt),
  };
}

function mapContext(row: typeof collaborationContexts.$inferSelect): CollaborationContextRecord {
  return {
    ...row,
    classification: row.classification as CollaborationContextRecord["classification"],
    status: row.status as CollaborationContextRecord["status"],
    expiresAt: row.expiresAt ? at(row.expiresAt) : null,
    createdAt: at(row.createdAt),
    closedAt: row.closedAt ? at(row.closedAt) : null,
  };
}

function mapParticipant(row: typeof collaborationParticipants.$inferSelect): CollaborationParticipantRecord {
  return { ...row, role: row.role as CollaborationParticipantRecord["role"], status: row.status as CollaborationParticipantRecord["status"], createdAt: at(row.createdAt) };
}

function mapEntry(row: typeof collaborationEntries.$inferSelect): CollaborationEntryRecord {
  return {
    ...row,
    kind: row.kind as CollaborationEntryRecord["kind"],
    provenance: row.provenance as CollaborationEntryRecord["provenance"],
    status: row.status as CollaborationEntryRecord["status"],
    expiresAt: row.expiresAt ? at(row.expiresAt) : null,
    createdAt: at(row.createdAt),
  };
}

function mapOwnership(row: typeof memoryOwnership.$inferSelect): MemoryOwnershipRecord {
  return {
    ...row,
    classification: row.classification as MemoryOwnershipRecord["classification"],
    validationStatus: row.validationStatus as MemoryOwnershipRecord["validationStatus"],
    createdAt: at(row.createdAt),
  };
}
