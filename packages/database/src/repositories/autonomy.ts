import { and, asc, count, desc, eq, ilike, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  readProgress,
  type AutonomyRepository,
  type AutonomySettings,
  type ColonyGoalRecord,
  type ConversationRecord,
  type ConversationTurnRecord,
  type ConversationJob,
  type ContextEventRecord,
  type DepartmentRef,
  type GoalCycleRecord,
  type MembershipEventRecord,
  type MembershipRecord,
  type SubgoalRecord,
  type TurnClaim,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import {
  agents,
  colonyAutonomy,
  colonyGoalCycles,
  colonyGoals,
  conversationContextEvents,
  conversationJobs,
  conversationMembershipEvents,
  conversationParticipants,
  conversationTurnClaims,
  conversationTurns,
  departmentConversations,
  departments,
  memories,
  objectiveRuns,
  objectiveSubgoals,
  objectiveTasks,
} from "../schema/index.js";

const addressedDepartments = alias(departments, "addressed_departments");

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapSettings(row: typeof colonyAutonomy.$inferSelect): AutonomySettings {
  return {
    enabled: row.enabled,
    paused: row.paused,
    intervalMs: row.intervalMs,
    cooldownMs: row.cooldownMs,
    maxActiveGoals: row.maxActiveGoals,
    maxInferenceRequests: row.maxInferenceRequests,
    maxDurationMs: row.maxDurationMs,
    maxConversations: row.maxConversations,
    maxConversationMessages: row.maxConversationMessages,
    maxConversationTokens: row.maxConversationTokens,
    maxConversationParticipants: row.maxConversationParticipants,
    conversationExecutionEnabled: row.conversationExecutionEnabled,
    maxConcurrentConversationTurns: row.maxConcurrentConversationTurns,
    contextTokenBudget: row.contextTokenBudget,
    conversationSoftTokenBudget: row.conversationSoftTokenBudget,
    conversationHardTokenCeiling: row.conversationHardTokenCeiling,
    conversationCheckpointTurns: row.conversationCheckpointTurns,
    maxInferenceOutputTokens: row.maxInferenceOutputTokens,
    maxInferenceEstimatedTokens: row.maxInferenceEstimatedTokens,
    consumedInferenceRequests: row.consumedInferenceRequests,
    reservedInferenceRequests: row.reservedInferenceRequests,
    consumedInputTokens: row.consumedInputTokens,
    consumedOutputTokens: row.consumedOutputTokens,
    estimatedInputTokens: row.estimatedInputTokens,
    estimatedOutputTokens: row.estimatedOutputTokens,
    reservedOutputTokens: row.reservedOutputTokens,
    estimatedCostUsdMicros: row.estimatedCostUsdMicros,
    lastCycleAt: iso(row.lastCycleAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createAutonomyRepository(db: DbExecutor): AutonomyRepository {
  return {
    async settings() {
      const [row] = await db.select().from(colonyAutonomy).where(eq(colonyAutonomy.id, "default")).limit(1);
      if (!row) {
        throw new Error("Colony autonomy settings are not installed");
      }
      return mapSettings(row);
    },
    async saveSettings(patch) {
      const [row] = await db
        .update(colonyAutonomy)
        .set({
          updatedAt: new Date(),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
          ...(patch.intervalMs !== undefined ? { intervalMs: patch.intervalMs } : {}),
          ...(patch.cooldownMs !== undefined ? { cooldownMs: patch.cooldownMs } : {}),
          ...(patch.maxActiveGoals !== undefined ? { maxActiveGoals: patch.maxActiveGoals } : {}),
          ...(patch.maxInferenceRequests !== undefined ? { maxInferenceRequests: patch.maxInferenceRequests } : {}),
          ...(patch.maxDurationMs !== undefined ? { maxDurationMs: patch.maxDurationMs } : {}),
          ...(patch.maxConversations !== undefined ? { maxConversations: patch.maxConversations } : {}),
          ...(patch.maxConversationMessages !== undefined ? { maxConversationMessages: patch.maxConversationMessages } : {}),
          ...(patch.maxConversationTokens !== undefined ? { maxConversationTokens: patch.maxConversationTokens } : {}),
          ...(patch.maxConversationParticipants !== undefined ? { maxConversationParticipants: patch.maxConversationParticipants } : {}),
          ...(patch.conversationExecutionEnabled !== undefined ? { conversationExecutionEnabled: patch.conversationExecutionEnabled } : {}),
          ...(patch.maxConcurrentConversationTurns !== undefined ? { maxConcurrentConversationTurns: patch.maxConcurrentConversationTurns } : {}),
          ...(patch.contextTokenBudget !== undefined ? { contextTokenBudget: patch.contextTokenBudget } : {}),
          ...(patch.conversationSoftTokenBudget !== undefined ? { conversationSoftTokenBudget: patch.conversationSoftTokenBudget } : {}),
          ...(patch.conversationHardTokenCeiling !== undefined ? { conversationHardTokenCeiling: patch.conversationHardTokenCeiling } : {}),
          ...(patch.conversationCheckpointTurns !== undefined ? { conversationCheckpointTurns: patch.conversationCheckpointTurns } : {}),
          ...(patch.lastCycleAt !== undefined ? { lastCycleAt: patch.lastCycleAt } : {}),
        })
        .where(eq(colonyAutonomy.id, "default"))
        .returning();
      if (!row) {
        throw new Error("Colony autonomy settings are not installed");
      }
      return mapSettings(row);
    },
    async insertCycle(input) {
      await db.insert(colonyGoalCycles).values({
        id: input.id,
        outcome: input.outcome,
        rationale: input.rationale,
        goalId: input.goalId,
        prompt: input.prompt,
        responseText: input.responseText,
      });
    },
    async listCycles(limit) {
      const rows = await db.select().from(colonyGoalCycles).orderBy(desc(colonyGoalCycles.createdAt)).limit(limit);
      return rows.map((row) => ({
        id: row.id,
        outcome: row.outcome,
        rationale: row.rationale,
        goalId: row.goalId,
        prompt: row.prompt,
        responseText: row.responseText,
        createdAt: row.createdAt.toISOString(),
      })) satisfies GoalCycleRecord[];
    },
    async insertGoal(input) {
      await db.insert(colonyGoals).values({
        id: input.id,
        objectiveId: input.objectiveId,
        description: input.description,
        normalizedDescription: input.normalizedDescription,
        motivation: input.motivation,
        evidence: input.evidence,
        hypotheses: input.hypotheses,
        expectedBenefit: input.expectedBenefit,
        successCriteria: input.successCriteria,
        estimatedInferenceRequests: input.estimatedInferenceRequests,
        departments: input.departments,
        priority: input.priority,
        stopConditions: input.stopConditions,
        status: input.status,
      });
    },
    async listGoals(limit) {
      const rows = await db
        .select({ goal: colonyGoals, objectiveStatus: objectiveRuns.status })
        .from(colonyGoals)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, colonyGoals.objectiveId))
        .orderBy(desc(colonyGoals.createdAt))
        .limit(limit);
      return rows.map((row) => mapGoal(row.goal, row.objectiveStatus));
    },
    async findGoal(id) {
      const [row] = await db
        .select({ goal: colonyGoals, objectiveStatus: objectiveRuns.status })
        .from(colonyGoals)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, colonyGoals.objectiveId))
        .where(eq(colonyGoals.id, id))
        .limit(1);
      return row ? mapGoal(row.goal, row.objectiveStatus) : null;
    },
    async findActiveByDescription(normalized) {
      const [row] = await db
        .select({ goal: colonyGoals, objectiveStatus: objectiveRuns.status })
        .from(colonyGoals)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, colonyGoals.objectiveId))
        .where(and(eq(colonyGoals.normalizedDescription, normalized), eq(colonyGoals.status, "selected")))
        .limit(1);
      if (!row || row.goal.status === "cancelled" || row.objectiveStatus === "cancelled" || row.objectiveStatus === "failed" || row.objectiveStatus === "completed") {
        return null;
      }
      return mapGoal(row.goal, row.objectiveStatus);
    },
    async countSelectedGoals() {
      const [row] = await db
        .select({ value: count() })
        .from(colonyGoals)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, colonyGoals.objectiveId))
        .where(sql`${colonyGoals.status} = 'selected' and ${objectiveRuns.status} not in ('completed', 'failed', 'cancelled')`);
      return Number(row?.value ?? 0);
    },
    async saveGoal(id, status) {
      await db.update(colonyGoals).set({ status, updatedAt: new Date() }).where(eq(colonyGoals.id, id));
    },
    async insertSubgoal(input) {
      await db.insert(objectiveSubgoals).values(input);
    },
    async findSubgoalByKey(key) {
      const [row] = await db.select().from(objectiveSubgoals).where(eq(objectiveSubgoals.idempotencyKey, key)).limit(1);
      return row ? mapSubgoal(row) : null;
    },
    async listSubgoals(objectiveId) {
      const rows = await db.select().from(objectiveSubgoals).where(eq(objectiveSubgoals.objectiveId, objectiveId));
      return rows.map(mapSubgoal);
    },
    async department(id): Promise<DepartmentRef | null> {
      const [row] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
      return row ? { id: row.id, slug: row.slug, name: row.name, status: row.status } : null;
    },
    async insertConversation(input) {
      await db.insert(departmentConversations).values({
        id: input.id,
        topic: input.topic,
        objectiveId: input.objectiveId,
        openedByDepartmentId: input.openedByDepartmentId,
        status: input.status,
        maxMessages: input.maxMessages,
        maxTokens: input.maxTokens,
        maxDurationMs: input.maxDurationMs,
        openingInstruction: input.openingInstruction,
      });
    },
    async findConversation(id) {
      const [row] = await db.select().from(departmentConversations).where(eq(departmentConversations.id, id)).limit(1);
      return row ? mapConversation(row) : null;
    },
    async lockConversation(id) {
      const [row] = await db.select().from(departmentConversations).where(eq(departmentConversations.id, id)).for("update").limit(1);
      return row ? mapConversation(row) : null;
    },
    async listConversations(limit) {
      const rows = await db.select().from(departmentConversations).orderBy(desc(departmentConversations.openedAt)).limit(limit);
      return rows.map(mapConversation);
    },
    async saveConversation(id, patch) {
      await db
        .update(departmentConversations)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.closeReason !== undefined ? { closeReason: patch.closeReason } : {}),
          ...(patch.finalConclusion !== undefined ? { finalConclusion: patch.finalConclusion } : {}),
          ...(patch.remainingDisagreements !== undefined ? { remainingDisagreements: patch.remainingDisagreements } : {}),
          ...(patch.evidenceRefs !== undefined ? { evidenceRefs: patch.evidenceRefs } : {}),
          ...(patch.contextSummary !== undefined ? { contextSummary: patch.contextSummary } : {}),
          ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
          ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
          ...(patch.runnerStatus !== undefined ? { runnerStatus: patch.runnerStatus } : {}),
          ...(patch.runnerFence !== undefined ? { runnerFence: patch.runnerFence } : {}),
          ...(patch.runnerLeaseUntil !== undefined ? { runnerLeaseUntil: patch.runnerLeaseUntil } : {}),
          ...(patch.parentConversationId !== undefined ? { parentConversationId: patch.parentConversationId } : {}),
          ...(patch.scheduledSpeakerId !== undefined ? { scheduledSpeakerId: patch.scheduledSpeakerId } : {}),
          ...(patch.recommendedSpeakerId !== undefined ? { recommendedSpeakerId: patch.recommendedSpeakerId } : {}),
          ...(patch.speakerRecommendationReason !== undefined ? { speakerRecommendationReason: patch.speakerRecommendationReason } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.lastInferenceLatencyMs !== undefined ? { lastInferenceLatencyMs: patch.lastInferenceLatencyMs } : {}),
          ...(patch.lastInferenceEndpoint !== undefined ? { lastInferenceEndpoint: patch.lastInferenceEndpoint } : {}),
          ...(patch.progressState !== undefined ? { progressState: patch.progressState as unknown as Record<string, unknown> } : {}),
          ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
          ...(patch.closedAt !== undefined ? { closedAt: patch.closedAt } : {}),
        })
        .where(eq(departmentConversations.id, id));
    },
    async addParticipant(conversationId, departmentId) {
      await db.insert(conversationParticipants).values({
        conversationId,
        departmentId,
        membership: "active",
        joinedAt: new Date(),
      }).onConflictDoNothing();
    },
    async listParticipants(conversationId) {
      const rows = await db
        .select()
        .from(conversationParticipants)
        .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.membership, "active")));
      return rows.map((row) => row.departmentId);
    },
    async listMembership(conversationId) {
      const rows = await db
        .select({ membership: conversationParticipants, slug: departments.slug })
        .from(conversationParticipants)
        .innerJoin(departments, eq(departments.id, conversationParticipants.departmentId))
        .where(eq(conversationParticipants.conversationId, conversationId));
      return rows.map((row) => mapMembership(row.membership, row.slug));
    },
    async upsertMembership(input) {
      await db
        .insert(conversationParticipants)
        .values({
          conversationId: input.conversationId,
          departmentId: input.departmentId,
          membership: input.membership,
          participantRole: input.role,
          joinSequence: input.joinSequence,
          invitedByDepartmentId: input.invitedByDepartmentId,
          joinedAt: input.joinedAt,
          removedAt: input.removedAt,
        })
        .onConflictDoUpdate({
          target: [conversationParticipants.conversationId, conversationParticipants.departmentId],
          set: {
            membership: input.membership,
            participantRole: input.role,
            joinSequence: input.joinSequence,
            invitedByDepartmentId: input.invitedByDepartmentId,
            joinedAt: input.joinedAt,
            removedAt: input.removedAt,
          },
        });
    },
    async insertMembershipEvent(input) {
      await db.insert(conversationMembershipEvents).values(input);
    },
    async listMembershipEvents(conversationId) {
      const rows = await db
        .select({ event: conversationMembershipEvents, slug: departments.slug })
        .from(conversationMembershipEvents)
        .innerJoin(departments, eq(departments.id, conversationMembershipEvents.departmentId))
        .where(eq(conversationMembershipEvents.conversationId, conversationId))
        .orderBy(asc(conversationMembershipEvents.createdAt));
      return rows.map((row) => mapMembershipEvent(row.event, row.slug));
    },
    async departmentAgent(departmentId) {
      const [row] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(eq(agents.departmentId, departmentId))
        .limit(1);
      return row ?? null;
    },
    async allocateSequence(conversationId) {
      const [row] = await db
        .update(departmentConversations)
        .set({ nextSequence: sql`${departmentConversations.nextSequence} + 1` })
        .where(eq(departmentConversations.id, conversationId))
        .returning({ nextSequence: departmentConversations.nextSequence });
      if (!row) {
        throw new Error("Conversation sequence is unavailable");
      }
      return row.nextSequence;
    },
    async countOpenConversations() {
      const [row] = await db.select({ value: count() }).from(departmentConversations).where(eq(departmentConversations.status, "open"));
      return Number(row?.value ?? 0);
    },
    async insertTurn(input) {
      await db.insert(conversationTurns).values(input);
    },
    async findTurnByKey(key) {
      const [row] = await db
        .select({ turn: conversationTurns, slug: departments.slug, addressedSlug: addressedDepartments.slug })
        .from(conversationTurns)
        .innerJoin(departments, eq(departments.id, conversationTurns.departmentId))
        .leftJoin(addressedDepartments, eq(addressedDepartments.id, conversationTurns.addressedDepartmentId))
        .where(eq(conversationTurns.idempotencyKey, key))
        .limit(1);
      return row ? mapTurn(row.turn, row.slug, row.addressedSlug) : null;
    },
    async listTurns(conversationId) {
      const rows = await db
        .select({ turn: conversationTurns, slug: departments.slug, addressedSlug: addressedDepartments.slug })
        .from(conversationTurns)
        .innerJoin(departments, eq(departments.id, conversationTurns.departmentId))
        .leftJoin(addressedDepartments, eq(addressedDepartments.id, conversationTurns.addressedDepartmentId))
        .where(eq(conversationTurns.conversationId, conversationId))
        .orderBy(asc(conversationTurns.sequence), asc(conversationTurns.createdAt));
      return rows.map((row) => mapTurn(row.turn, row.slug, row.addressedSlug));
    },
    async findClaim(key) {
      const [row] = await db.select().from(conversationTurnClaims).where(eq(conversationTurnClaims.idempotencyKey, key)).limit(1);
      return row ? mapClaim(row) : null;
    },
    async insertClaim(input) {
      await db.insert(conversationTurnClaims).values({
        idempotencyKey: input.idempotencyKey,
        conversationId: input.conversationId,
        departmentId: input.departmentId,
        kind: input.kind,
        addressedDepartmentId: input.addressedDepartmentId,
        parentMessageId: input.parentMessageId,
        sequence: input.sequence,
        body: input.body ?? null,
        prompt: input.prompt ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        ...(input.updatedAt ? { updatedAt: input.updatedAt, createdAt: input.updatedAt } : {}),
      });
    },
    async saveClaimBody(key, patch) {
      await db
        .update(conversationTurnClaims)
        .set({
          body: patch.body,
          prompt: patch.prompt,
          inputTokens: patch.inputTokens,
          outputTokens: patch.outputTokens,
          updatedAt: patch.at,
        })
        .where(eq(conversationTurnClaims.idempotencyKey, key));
    },
    async recordTurnUsage(conversationId, usage) {
      await db
        .update(departmentConversations)
        .set({
          messageCount: sql`${departmentConversations.messageCount} + 1`,
          inferenceRequests: sql`${departmentConversations.inferenceRequests} + ${usage.requests}`,
          inputTokens: sql`${departmentConversations.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${departmentConversations.outputTokens} + ${usage.outputTokens}`,
          lastTurnAt: usage.at,
        })
        .where(eq(departmentConversations.id, conversationId));
    },
    async countMemories() {
      const [row] = await db.select({ value: count() }).from(memories);
      return Number(row?.value ?? 0);
    },
    async addContextTokens(conversationId, tokens) {
      await db
        .update(departmentConversations)
        .set({
          inputTokens: sql`${departmentConversations.inputTokens} + ${tokens}`,
        })
        .where(eq(departmentConversations.id, conversationId));
    },
    async countBlockingHumanWork() {
      const [row] = await db
        .select({ value: count() })
        .from(objectiveTasks)
        .innerJoin(objectiveRuns, eq(objectiveRuns.id, objectiveTasks.objectiveId))
        .where(sql`${objectiveRuns.origin} = 'human' and ${objectiveRuns.status} in ('scheduled', 'running') and ${objectiveTasks.status} in ('pending', 'ready', 'dispatched', 'running')`);
      return Number(row?.value ?? 0);
    },
    async searchTurns(conversationId, query, limit) {
      const needle = query.replace(/[%_]/g, "").trim();
      if (!needle) {
        return [];
      }
      const rows = await db
        .select({ turn: conversationTurns, slug: departments.slug, addressedSlug: addressedDepartments.slug })
        .from(conversationTurns)
        .innerJoin(departments, eq(departments.id, conversationTurns.departmentId))
        .leftJoin(addressedDepartments, eq(addressedDepartments.id, conversationTurns.addressedDepartmentId))
        .where(and(eq(conversationTurns.conversationId, conversationId), ilike(conversationTurns.body, `%${needle}%`)))
        .orderBy(desc(conversationTurns.createdAt))
        .limit(limit);
      return rows.map((row) => mapTurn(row.turn, row.slug, row.addressedSlug));
    },
    async insertContextEvent(input) {
      await db.insert(conversationContextEvents).values(input);
    },
    async listContextEvents(conversationId) {
      const rows = await db
        .select()
        .from(conversationContextEvents)
        .where(eq(conversationContextEvents.conversationId, conversationId))
        .orderBy(asc(conversationContextEvents.createdAt));
      return rows.map(mapContextEvent);
    },
    async insertJob(input) {
      await db.insert(conversationJobs).values({
        id: input.id,
        conversationId: input.conversationId,
        idempotencyKey: input.idempotencyKey,
        fence: input.fence,
        status: input.status,
        action: input.action,
      });
    },
    async findJob(id) {
      const [row] = await db.select().from(conversationJobs).where(eq(conversationJobs.id, id)).limit(1);
      return row ? mapJob(row) : null;
    },
    async findActiveJob(conversationId) {
      const [row] = await db
        .select()
        .from(conversationJobs)
        .where(and(eq(conversationJobs.conversationId, conversationId), sql`${conversationJobs.status} in ('pending', 'leased')`))
        .limit(1);
      return row ? mapJob(row) : null;
    },
    async expireLeases(now) {
      await db
        .update(conversationJobs)
        .set({ status: "pending", leaseToken: null, leaseUntil: null })
        .where(and(eq(conversationJobs.status, "leased"), lt(conversationJobs.leaseUntil, now)));
    },
    async leaseJob(id, token, until, speakerDepartmentId) {
      const rows = await db
        .update(conversationJobs)
        .set({
          status: "leased",
          leaseToken: token,
          leaseUntil: until,
          speakerDepartmentId,
          attempt: sql`${conversationJobs.attempt} + 1`,
        })
        .where(and(eq(conversationJobs.id, id), eq(conversationJobs.status, "pending")))
        .returning({ id: conversationJobs.id });
      return rows.length > 0;
    },
    async completeJob(id, token, at) {
      const rows = await db
        .update(conversationJobs)
        .set({ status: "completed", completedAt: at, leaseToken: null, leaseUntil: null })
        .where(and(eq(conversationJobs.id, id), eq(conversationJobs.leaseToken, token), eq(conversationJobs.status, "leased")))
        .returning({ id: conversationJobs.id });
      return rows.length > 0;
    },
    async releaseJob(id, token, error) {
      const rows = await db
        .update(conversationJobs)
        .set({ status: "dead", lastError: error, leaseToken: null, leaseUntil: null, completedAt: new Date() })
        .where(and(eq(conversationJobs.id, id), eq(conversationJobs.leaseToken, token), eq(conversationJobs.status, "leased")))
        .returning({ id: conversationJobs.id });
      return rows.length > 0;
    },
    async retireJob(id, error) {
      await db
        .update(conversationJobs)
        .set({ status: "dead", lastError: error, leaseToken: null, leaseUntil: null, completedAt: new Date() })
        .where(and(eq(conversationJobs.id, id), sql`${conversationJobs.status} in ('pending', 'leased')`));
    },
    async countLeasedJobs() {
      const [row] = await db.select({ value: count() }).from(conversationJobs).where(eq(conversationJobs.status, "leased"));
      return Number(row?.value ?? 0);
    },
    async countLeasedForDepartment(departmentId) {
      const [row] = await db
        .select({ value: count() })
        .from(conversationJobs)
        .where(and(eq(conversationJobs.status, "leased"), eq(conversationJobs.speakerDepartmentId, departmentId)));
      return Number(row?.value ?? 0);
    },
  };
}

function mapGoal(row: typeof colonyGoals.$inferSelect, objectiveStatus: string): ColonyGoalRecord {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    description: row.description,
    normalizedDescription: row.normalizedDescription,
    motivation: row.motivation,
    evidence: row.evidence,
    hypotheses: row.hypotheses,
    expectedBenefit: row.expectedBenefit,
    successCriteria: row.successCriteria,
    estimatedInferenceRequests: row.estimatedInferenceRequests,
    departments: row.departments,
    priority: row.priority as ColonyGoalRecord["priority"],
    stopConditions: row.stopConditions,
    status: row.status as ColonyGoalRecord["status"],
    objectiveStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapSubgoal(row: typeof objectiveSubgoals.$inferSelect): SubgoalRecord {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    departmentId: row.departmentId,
    agentId: row.agentId,
    description: row.description,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapConversation(row: typeof departmentConversations.$inferSelect): ConversationRecord {
  return {
    id: row.id,
    topic: row.topic,
    objectiveId: row.objectiveId,
    openedByDepartmentId: row.openedByDepartmentId,
    status: row.status as ConversationRecord["status"],
    messageCount: row.messageCount,
    inferenceRequests: row.inferenceRequests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    maxMessages: row.maxMessages,
    maxTokens: row.maxTokens,
    maxDurationMs: row.maxDurationMs,
    closeReason: row.closeReason,
    finalConclusion: row.finalConclusion,
    remainingDisagreements: row.remainingDisagreements,
    evidenceRefs: row.evidenceRefs,
    contextSummary: row.contextSummary,
    outcome: row.outcome,
    paused: row.paused,
    runnerStatus: row.runnerStatus as ConversationRecord["runnerStatus"],
    runnerFence: row.runnerFence,
    runnerLeaseUntil: iso(row.runnerLeaseUntil),
    parentConversationId: row.parentConversationId,
    scheduledSpeakerId: row.scheduledSpeakerId,
    recommendedSpeakerId: row.recommendedSpeakerId,
    speakerRecommendationReason: row.speakerRecommendationReason,
    lastError: row.lastError,
    lastInferenceLatencyMs: row.lastInferenceLatencyMs,
    lastInferenceEndpoint: row.lastInferenceEndpoint,
    progressState: readProgress(row.progressState),
    openingInstruction: row.openingInstruction,
    openedAt: row.openedAt.toISOString(),
    lastTurnAt: row.lastTurnAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

function mapTurn(row: typeof conversationTurns.$inferSelect, slug: string, addressedSlug: string | null): ConversationTurnRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    departmentId: row.departmentId,
    departmentSlug: slug,
    kind: row.kind,
    body: row.body,
    addressedDepartmentId: row.addressedDepartmentId,
    addressedDepartmentSlug: addressedSlug,
    sequence: row.sequence,
    parentMessageId: row.parentMessageId,
    prompt: row.prompt,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapMembership(row: typeof conversationParticipants.$inferSelect, slug: string): MembershipRecord {
  return {
    conversationId: row.conversationId,
    departmentId: row.departmentId,
    departmentSlug: slug,
    membership: row.membership as MembershipRecord["membership"],
    role: row.participantRole as MembershipRecord["role"],
    joinSequence: row.joinSequence,
    invitedByDepartmentId: row.invitedByDepartmentId,
    joinedAt: iso(row.joinedAt),
    removedAt: iso(row.removedAt),
  };
}

function mapMembershipEvent(row: typeof conversationMembershipEvents.$inferSelect, slug: string): MembershipEventRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    departmentId: row.departmentId,
    departmentSlug: slug,
    action: row.action as MembershipEventRecord["action"],
    actorDepartmentId: row.actorDepartmentId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapClaim(row: typeof conversationTurnClaims.$inferSelect): TurnClaim {
  return {
    idempotencyKey: row.idempotencyKey,
    conversationId: row.conversationId,
    departmentId: row.departmentId,
    kind: row.kind,
    addressedDepartmentId: row.addressedDepartmentId,
    parentMessageId: row.parentMessageId,
    sequence: row.sequence,
    body: row.body,
    prompt: row.prompt,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapJob(row: typeof conversationJobs.$inferSelect): ConversationJob {
  return {
    id: row.id,
    conversationId: row.conversationId,
    idempotencyKey: row.idempotencyKey,
    fence: row.fence,
    status: row.status as ConversationJob["status"],
    action: row.action as ConversationJob["action"],
    attempt: row.attempt,
    leaseToken: row.leaseToken,
    leaseUntil: iso(row.leaseUntil),
    speakerDepartmentId: row.speakerDepartmentId,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

function mapContextEvent(row: typeof conversationContextEvents.$inferSelect): ContextEventRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    departmentId: row.departmentId,
    kind: row.kind as ContextEventRecord["kind"],
    query: row.query,
    messageIds: row.messageIds,
    tokens: row.tokens,
    createdAt: row.createdAt.toISOString(),
  };
}
