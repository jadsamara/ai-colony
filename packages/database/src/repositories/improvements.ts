import type { DbExecutor } from "../client.js";
import type {
  EvaluationEvidence,
  ImprovementEvent,
  ImprovementProposal,
  ImprovementStore,
} from "@ai-colony/core";
import { asc, eq } from "drizzle-orm";
import { productImprovementEvents, productImprovementProposals } from "../schema/index.js";

export function createImprovementRepository(db: DbExecutor): ImprovementStore {
  return {
    async insert(proposal) {
      await db.insert(productImprovementProposals).values(toRow(proposal));
      return proposal;
    },
    async update(id, patch) {
      const [row] = await db
        .update(productImprovementProposals)
        .set({ ...toPatch(patch), updatedAt: new Date() })
        .where(eq(productImprovementProposals.id, id))
        .returning();
      if (!row) {
        throw new Error("Improvement proposal not found");
      }
      return fromRow(row);
    },
    async find(id) {
      const [row] = await db
        .select()
        .from(productImprovementProposals)
        .where(eq(productImprovementProposals.id, id))
        .limit(1);
      return row ? fromRow(row) : null;
    },
    async appendEvent(event) {
      await db.insert(productImprovementEvents).values({
        id: event.id,
        proposalId: event.proposalId,
        eventType: event.eventType,
        actorId: event.actorId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        metadata: event.metadata,
        createdAt: new Date(event.createdAt),
      });
    },
    async listEvents(proposalId) {
      const rows = await db
        .select()
        .from(productImprovementEvents)
        .where(eq(productImprovementEvents.proposalId, proposalId))
        .orderBy(asc(productImprovementEvents.createdAt));
      return rows.map(fromEvent);
    },
    async list() {
      const rows = await db.select().from(productImprovementProposals).orderBy(asc(productImprovementProposals.createdAt));
      return rows.map(fromRow);
    },
  };
}

function toRow(proposal: ImprovementProposal): typeof productImprovementProposals.$inferInsert {
  return {
    id: proposal.id,
    departmentId: proposal.departmentId,
    proposedByAgentId: proposal.proposedByAgentId,
    problem: proposal.problem,
    evidence: proposal.evidence,
    expectedBenefit: proposal.expectedBenefit,
    participants: proposal.participants,
    estimatedCost: proposal.estimatedCost,
    risk: proposal.risk,
    successCriteria: proposal.successCriteria,
    priority: proposal.priority,
    dependencies: proposal.dependencies,
    approvalRequirements: proposal.approvalRequirements,
    recommendsNewDepartment: proposal.recommendsNewDepartment,
    status: proposal.status,
    evaluationEvidence: proposal.evaluationEvidence as unknown as Record<string, unknown> | null,
    recommendation: proposal.recommendation,
    outcome: proposal.outcome,
    successful: proposal.successful,
    createdAt: new Date(proposal.createdAt),
    updatedAt: new Date(proposal.updatedAt),
  };
}

function toPatch(patch: Partial<ImprovementProposal>): Partial<typeof productImprovementProposals.$inferInsert> {
  return {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.evaluationEvidence !== undefined
      ? { evaluationEvidence: patch.evaluationEvidence as unknown as Record<string, unknown> | null }
      : {}),
    ...(patch.recommendation !== undefined ? { recommendation: patch.recommendation } : {}),
    ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
    ...(patch.successful !== undefined ? { successful: patch.successful } : {}),
  };
}

function fromRow(row: typeof productImprovementProposals.$inferSelect): ImprovementProposal {
  return {
    id: row.id,
    departmentId: row.departmentId,
    proposedByAgentId: row.proposedByAgentId,
    problem: row.problem,
    evidence: row.evidence as ImprovementProposal["evidence"],
    expectedBenefit: row.expectedBenefit,
    participants: row.participants as ImprovementProposal["participants"],
    estimatedCost: row.estimatedCost,
    risk: row.risk,
    successCriteria: row.successCriteria,
    priority: row.priority as ImprovementProposal["priority"],
    dependencies: row.dependencies as string[],
    approvalRequirements: row.approvalRequirements as string[],
    recommendsNewDepartment: row.recommendsNewDepartment,
    status: row.status as ImprovementProposal["status"],
    evaluationEvidence: (row.evaluationEvidence as EvaluationEvidence | null) ?? null,
    recommendation: (row.recommendation as ImprovementProposal["recommendation"]) ?? null,
    outcome: row.outcome,
    successful: row.successful,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fromEvent(row: typeof productImprovementEvents.$inferSelect): ImprovementEvent {
  return {
    id: row.id,
    proposalId: row.proposalId,
    eventType: row.eventType,
    actorId: row.actorId,
    fromStatus: (row.fromStatus as ImprovementEvent["fromStatus"]) ?? null,
    toStatus: (row.toStatus as ImprovementEvent["toStatus"]) ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}
