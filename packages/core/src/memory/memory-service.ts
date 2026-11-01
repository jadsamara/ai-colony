import { createHash, randomUUID } from "node:crypto";
import { EMBEDDING_DIMENSIONS, type Actor, type MemoryCreate, type MemoryMetrics, type MemoryPromotion, type MemoryRecord, type MemoryScope } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { permissionsForRole, ROLE_PERMISSIONS } from "../governance/permissions.js";
import { estimateTokens } from "../inference/usage.js";
import type { MemoryRepository, MemoryRow, MemoryVisibility, Persistence } from "../ports/repositories.js";
import { canReadMemory, nextScope } from "./access.js";
import { cosineSimilarity, EmbeddingError, type EmbeddingProvider } from "./embedding.js";
import { fitContext, rankMemories } from "./rank.js";

export const DEFAULT_MEMORY_LIMITS = {
  maxContentChars: 8000,
  maxSummaryChars: 1000,
  topK: 5,
  maxTopK: 20,
  minScore: 0.2,
  contextTokens: 800,
  maxWritesPerObjective: 12,
  consolidationBatchSize: 20,
  nearDuplicateCosine: 0.92,
  dimensions: EMBEDDING_DIMENSIONS,
};

export interface MemoryLimits {
  maxContentChars: number;
  maxSummaryChars: number;
  topK: number;
  maxTopK: number;
  minScore: number;
  contextTokens: number;
  maxWritesPerObjective: number;
  consolidationBatchSize: number;
  nearDuplicateCosine: number;
  dimensions: number;
}

const DEFAULT_STATUSES: MemoryRow["status"][] = ["candidate", "validated"];

export class MemoryService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly embeddings: EmbeddingProvider,
    private readonly limits: MemoryLimits = DEFAULT_MEMORY_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createMemory(ctx: RequestContext, input: MemoryCreate & { idempotencyKey?: string }): Promise<MemoryRecord> {
    this.authorizer.assert(ctx.actor, "memory:create");
    this.assertWritableScope(ctx.actor, input.scope, input.ownerAgentId ?? ctx.actor.agentId, input.departmentId ?? ctx.actor.departmentId);
    if (input.provenance === "externally_verified") {
      this.authorizer.assert(ctx.actor, "memory:admin");
    }
    const key = input.idempotencyKey ?? randomUUID();
    const existing = await this.persistence.repos.memories.findByKey(key);
    if (existing) {
      this.assertVisible(ctx.actor, existing);
      return publicMemory(existing);
    }
    if (input.objectiveId) {
      const writes = await this.persistence.repos.memories.countObjectiveSources(input.objectiveId);
      if (writes >= this.limits.maxWritesPerObjective) {
        throw new DomainError("LIMIT_EXCEEDED", "Objective memory write limit is exhausted", 409);
      }
    }
    const id = randomUUID();
    const record = this.draft(id, ctx, input, key);
    const outcome = await this.persistence.transaction(async (repos) => {
      const inserted = await repos.memories.insert(record);
      if (inserted === "exists") {
        return "exists" as const;
      }
      await repos.memories.insertRevision({
        id: randomUUID(),
        memoryId: id,
        revision: 1,
        status: record.status,
        summary: record.summary,
        createdAt: record.createdAt,
      });
      if (input.objectiveId || input.taskId || input.messageId) {
        await repos.memories.insertSource({
          id: randomUUID(),
          memoryId: id,
          objectiveId: input.objectiveId ?? null,
          taskId: input.taskId ?? null,
          messageId: input.messageId ?? null,
          sourceMemoryId: null,
          note: null,
        });
      }
      await repos.audit.append({
        eventType: "memory.created",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory",
        targetId: id,
        action: "memory.created",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { scope: record.scope, category: record.category, provenance: record.provenance, status: record.status },
        metadata: {},
      });
      return "created" as const;
    });
    const stored = await this.persistence.repos.memories.findByKey(key);
    if (!stored) {
      throw notFound("Memory", id);
    }
    if (outcome === "created") {
      await this.embed(stored.id, `${stored.title}\n${stored.summary}\n${stored.content}`);
    }
    const fresh = await this.persistence.repos.memories.findById(stored.id);
    return publicMemory(fresh ?? stored);
  }

  async getMemory(ctx: RequestContext, id: string): Promise<MemoryRecord> {
    this.authorizer.assertAny(ctx.actor, ["memory:read:own", "memory:read:department", "memory:read:colony", "memory:admin"]);
    const memory = await this.requireVisible(ctx.actor, id);
    if (memory.scope === "agent") {
      await this.persistence.repos.audit.append({
        eventType: "memory.read",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory",
        targetId: id,
        action: "memory.read",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: null,
        metadata: { scope: memory.scope },
      });
    }
    return publicMemory(memory);
  }

  async updateMemory(ctx: RequestContext, id: string, patch: { title?: string; summary?: string; content?: string }): Promise<MemoryRecord> {
    this.authorizer.assert(ctx.actor, "memory:update:own");
    const memory = await this.requireVisible(ctx.actor, id);
    if (!ROLE_PERMISSIONS[ctx.actor.role].has("memory:admin") && memory.ownerAgentId !== ctx.actor.agentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only the owning agent can revise this memory", 403);
    }
    if (memory.status === "archived" || memory.status === "superseded") {
      throw new DomainError("INVALID_STATE", "Archived or superseded memory cannot be revised", 409);
    }
    const summary = patch.summary ?? memory.summary;
    const content = patch.content ?? memory.content;
    const title = patch.title ?? memory.title;
    await this.persistence.transaction(async (repos) => {
      await repos.memories.update(id, {
        title,
        summary,
        content,
        contentHash: hashContent(content),
        embeddingError: null,
        updatedAt: this.now(),
      });
      const revisions = await repos.memories.listRevisions(id);
      await repos.memories.insertRevision({
        id: randomUUID(),
        memoryId: id,
        revision: revisions.length + 1,
        status: memory.status,
        summary,
        createdAt: this.now(),
      });
    });
    await this.embed(id, `${title}\n${summary}\n${content}`);
    return publicMemory(await this.requireVisible(ctx.actor, id));
  }

  async searchMemories(ctx: RequestContext, input: {
    query: string;
    topK?: number;
    minScore?: number;
    scopes?: MemoryRow["scope"][];
    categories?: MemoryRow["category"][];
    statuses?: MemoryRow["status"][];
    objectiveId?: string | null;
    taskId?: string | null;
    recordUsage?: boolean;
  }) {
    this.authorizer.assert(ctx.actor, "memory:search");
    const started = Date.now();
    const topK = Math.min(input.topK ?? this.limits.topK, this.limits.maxTopK);
    const minScore = input.minScore ?? this.limits.minScore;
    let mode: "hybrid" | "keyword" = "hybrid";
    let vector: number[] | null = null;
    try {
      const embedded = await this.embeddings.embedText(input.query);
      this.assertVector(embedded.values, embedded.model);
      vector = embedded.values;
    } catch (error) {
      mode = "keyword";
      await this.persistence.repos.memories.recordEmbeddingUse({
        id: randomUUID(),
        model: this.embeddings.getModelInfo().model,
        vectorCount: 0,
        latencyMs: Date.now() - started,
        success: false,
        error: error instanceof Error ? error.message : "embedding failed",
        createdAt: this.now(),
      });
    }
    const rows = await this.persistence.repos.memories.search({
      query: input.query,
      vector,
      embeddingModel: this.embeddings.getModelInfo().model,
      visibility: visibilityFor(ctx.actor),
      scopes: input.scopes,
      categories: input.categories,
      statuses: input.statuses ?? DEFAULT_STATUSES,
      limit: 200,
    });
    const ranked = rankMemories(rows, this.now(), mode)
      .filter((item) => item.score >= minScore)
      .slice(0, topK);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const hits = ranked.flatMap((item) => {
      const row = byId.get(item.id);
      if (!row) {
        return [];
      }
      return [{ ...publicMemory(row), score: item.score, vectorScore: item.vectorScore, keywordScore: item.keywordScore, retrievalMode: item.mode }];
    });
    if (input.recordUsage !== false) {
      await this.persistence.repos.memories.recordRetrieval({
        id: randomUUID(),
        objectiveId: input.objectiveId ?? null,
        taskId: input.taskId ?? null,
        actorId: ctx.actor.principalId,
        queryHash: createHash("sha256").update(input.query).digest("hex"),
        mode,
        hitCount: hits.length,
        latencyMs: Date.now() - started,
        createdAt: this.now(),
        hits: hits.map((hit, index) => ({ memoryId: hit.id, rank: index + 1, score: hit.score })),
      });
    }
    return { mode, hits };
  }

  async retrieveRelevantMemories(ctx: RequestContext, input: { query: string; objectiveId?: string | null; taskId?: string | null }) {
    const result = await this.searchMemories(ctx, { ...input, topK: this.limits.topK, recordUsage: true });
    const fitted = fitContext(result.hits, this.limits.contextTokens, estimateTokens);
    return { mode: result.mode, hits: fitted };
  }

  async archiveMemory(ctx: RequestContext, id: string): Promise<MemoryRecord> {
    this.authorizer.assert(ctx.actor, "memory:archive");
    const memory = await this.requireVisible(ctx.actor, id);
    if (!ROLE_PERMISSIONS[ctx.actor.role].has("memory:admin") && memory.ownerAgentId !== ctx.actor.agentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Only the owning agent can archive this memory", 403);
    }
    await this.changeStatus(ctx, memory, "archived");
    return publicMemory(await this.requireVisible(ctx.actor, id));
  }

  async disputeMemory(ctx: RequestContext, id: string, otherId: string, reason: string): Promise<void> {
    this.authorizer.assertAny(ctx.actor, ["memory:admin", "memory:update:own"]);
    const left = await this.requireVisible(ctx.actor, id);
    const right = await this.requireVisible(ctx.actor, otherId);
    if (left.id === right.id) {
      throw new DomainError("INVALID_STATE", "A memory cannot contradict itself", 409);
    }
    await this.persistence.transaction(async (repos) => {
      await repos.memories.linkContradiction(left.id, right.id, this.now());
      for (const memory of [left, right]) {
        await repos.memories.update(memory.id, { status: "disputed", updatedAt: this.now() });
        const revisions = await repos.memories.listRevisions(memory.id);
        await repos.memories.insertRevision({
          id: randomUUID(),
          memoryId: memory.id,
          revision: revisions.length + 1,
          status: "disputed",
          summary: memory.summary,
          createdAt: this.now(),
        });
      }
      await repos.audit.append({
        eventType: "memory.disputed",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory",
        targetId: left.id,
        action: "memory.disputed",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { otherMemoryId: right.id },
        metadata: { reason },
      });
    });
  }

  async proposePromotion(ctx: RequestContext, id: string, reason: string): Promise<MemoryPromotion> {
    this.authorizer.assert(ctx.actor, "memory:promote:propose");
    const memory = await this.requireVisible(ctx.actor, id);
    const destination = nextScope(memory.scope);
    if (!destination) {
      throw new DomainError("INVALID_STATE", "Colony memory cannot be promoted further", 409);
    }
    if (destination === "department" && !memory.departmentId) {
      throw new DomainError("INVALID_STATE", "Agent memory has no department to promote into", 409);
    }
    const promotionId = randomUUID();
    await this.persistence.transaction(async (repos) => {
      await repos.memories.insertPromotion({
        id: promotionId,
        memoryId: memory.id,
        fromScope: memory.scope,
        toScope: destination,
        status: "pending",
        reason,
        proposedBy: ctx.actor.principalId,
        createdAt: this.now(),
      });
      await repos.audit.append({
        eventType: "memory.promotion_proposed",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory_promotion",
        targetId: promotionId,
        action: "memory.promotion_proposed",
        correlationId: ctx.correlationId,
        beforeState: { scope: memory.scope },
        afterState: { scope: destination },
        metadata: { memoryId: memory.id },
      });
    });
    const promotion = await this.persistence.repos.memories.findPromotion(promotionId);
    if (!promotion) {
      throw notFound("MemoryPromotion", promotionId);
    }
    return publicPromotion(promotion);
  }

  async approvePromotion(ctx: RequestContext, id: string, reason: string): Promise<MemoryPromotion> {
    this.authorizer.assert(ctx.actor, "memory:promote:approve");
    const promotion = await this.persistence.repos.memories.findPromotion(id);
    if (!promotion) {
      throw notFound("MemoryPromotion", id);
    }
    if (promotion.status !== "pending") {
      throw new DomainError("INVALID_STATE", "Promotion is already decided", 409);
    }
    const source = await this.persistence.repos.memories.findById(promotion.memoryId);
    if (!source) {
      throw notFound("Memory", promotion.memoryId);
    }
    const createdId = randomUUID();
    const created = this.draft(createdId, ctx, {
      scope: promotion.toScope,
      category: source.category,
      ownerAgentId: promotion.toScope === "agent" ? source.ownerAgentId ?? undefined : undefined,
      departmentId: promotion.toScope === "department" ? source.departmentId ?? undefined : undefined,
      title: source.title,
      summary: source.summary,
      content: source.content,
      provenance: source.provenance,
      qualityScore: source.qualityScore ?? undefined,
    }, `promotion:${promotion.id}`);
    created.status = "validated";
    created.originAgentId = source.originAgentId;
    await this.persistence.transaction(async (repos) => {
      await repos.memories.insert(created);
      await repos.memories.insertRevision({
        id: randomUUID(),
        memoryId: createdId,
        revision: 1,
        status: "validated",
        summary: created.summary,
        createdAt: this.now(),
      });
      await repos.memories.insertSource({
        id: randomUUID(),
        memoryId: createdId,
        objectiveId: null,
        taskId: null,
        messageId: null,
        sourceMemoryId: source.id,
        note: "promotion",
      });
      await repos.memories.decidePromotion(promotion.id, {
        status: "approved",
        decidedBy: ctx.actor.principalId,
        decisionReason: reason,
        createdMemoryId: createdId,
        decidedAt: this.now(),
      });
      await repos.audit.append({
        eventType: "memory.promotion_approved",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory_promotion",
        targetId: promotion.id,
        action: "memory.promotion_approved",
        correlationId: ctx.correlationId,
        beforeState: { scope: promotion.fromScope, provenance: source.provenance },
        afterState: { scope: promotion.toScope, memoryId: createdId, provenance: source.provenance },
        metadata: { reason },
      });
    });
    await this.embed(createdId, `${created.title}\n${created.summary}\n${created.content}`);
    const decided = await this.persistence.repos.memories.findPromotion(promotion.id);
    if (!decided) {
      throw notFound("MemoryPromotion", promotion.id);
    }
    return publicPromotion(decided);
  }

  async rejectPromotion(ctx: RequestContext, id: string, reason: string): Promise<MemoryPromotion> {
    this.authorizer.assert(ctx.actor, "memory:promote:approve");
    const promotion = await this.persistence.repos.memories.findPromotion(id);
    if (!promotion) {
      throw notFound("MemoryPromotion", id);
    }
    if (promotion.status !== "pending") {
      throw new DomainError("INVALID_STATE", "Promotion is already decided", 409);
    }
    await this.persistence.transaction(async (repos) => {
      await repos.memories.decidePromotion(id, {
        status: "rejected",
        decidedBy: ctx.actor.principalId,
        decisionReason: reason,
        createdMemoryId: null,
        decidedAt: this.now(),
      });
      await repos.audit.append({
        eventType: "memory.promotion_rejected",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory_promotion",
        targetId: id,
        action: "memory.promotion_rejected",
        correlationId: ctx.correlationId,
        beforeState: { status: "pending" },
        afterState: { status: "rejected" },
        metadata: { reason },
      });
    });
    const decided = await this.persistence.repos.memories.findPromotion(id);
    if (!decided) {
      throw notFound("MemoryPromotion", id);
    }
    return publicPromotion(decided);
  }

  async consolidateMemories(ctx: RequestContext, input: { memoryIds?: string[]; applyNearDuplicates?: boolean }) {
    this.authorizer.assert(ctx.actor, "memory:consolidate");
    const ids = input.memoryIds ?? [];
    const rows = [];
    for (const id of ids) {
      rows.push(await this.requireVisible(ctx.actor, id));
    }
    const applied = [];
    const proposals = [];
    if (rows.length >= 2) {
      const result = await this.mergeGroup(ctx, rows, input.applyNearDuplicates === true);
      if (result.applied && result.record) {
        applied.push(result.record);
      } else if (result.record) {
        proposals.push(result.record);
      }
    } else {
      const visible = await this.persistence.repos.memories.list({
        visibility: visibilityFor(ctx.actor),
        limit: this.limits.consolidationBatchSize,
      });
      const groups = new Map<string, MemoryRow[]>();
      for (const row of visible.filter((item) => item.status === "candidate" || item.status === "validated")) {
        const key = `${row.scope}:${row.category}:${row.contentHash}:${row.ownerAgentId ?? ""}:${row.departmentId ?? ""}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) {
          continue;
        }
        const result = await this.mergeGroup(ctx, group, false);
        if (result.applied && result.record) {
          applied.push(result.record);
        }
      }
    }
    return { applied, proposals };
  }

  async getMemoryHistory(ctx: RequestContext, id: string) {
    await this.requireVisible(ctx.actor, id);
    const revisions = await this.persistence.repos.memories.listRevisions(id);
    return revisions.map((revision) => ({
      id: revision.id,
      memoryId: revision.memoryId,
      revision: revision.revision,
      status: revision.status,
      summary: revision.summary,
      createdAt: revision.createdAt,
    }));
  }

  async listMemories(ctx: RequestContext, filter: { scope?: MemoryScope; category?: MemoryRow["category"]; status?: MemoryRow["status"]; cursor?: { createdAt: Date; id: string }; limit: number }) {
    this.authorizer.assertAny(ctx.actor, ["memory:read:own", "memory:read:department", "memory:read:colony", "memory:admin"]);
    const rows = await this.persistence.repos.memories.list({
      visibility: visibilityFor(ctx.actor),
      scope: filter.scope,
      category: filter.category,
      status: filter.status,
      cursor: filter.cursor,
      limit: filter.limit + 1,
    });
    return rows.map(publicMemory);
  }

  async listPromotions(ctx: RequestContext) {
    this.authorizer.assertAny(ctx.actor, ["memory:promote:propose", "memory:promote:approve", "memory:admin"]);
    const rows = await this.persistence.repos.memories.listPromotions(100);
    return rows.map(publicPromotion);
  }

  async metrics(ctx: RequestContext): Promise<MemoryMetrics> {
    this.authorizer.assertAny(ctx.actor, ["memory:admin", "monitoring:read"]);
    const metrics = await this.persistence.repos.memories.metrics();
    return {
      byScope: metrics.byScope,
      byCategory: metrics.byCategory,
      byStatus: metrics.byStatus,
      embeddingFailures: metrics.embeddingFailures,
      meanEmbeddingLatencyMs: metrics.meanEmbeddingLatencyMs,
      retrievals: metrics.retrievals,
      retrievalHitRate: metrics.retrievals === 0 ? null : metrics.retrievalHits / metrics.retrievals,
      meanRetrievalLatencyMs: metrics.meanRetrievalLatencyMs,
      promotions: metrics.promotions,
      consolidations: metrics.consolidations,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
    };
  }

  async noteOperational(code: string, summary: string): Promise<boolean> {
    const agent = await this.persistence.repos.memories.findAgentByRole("monitoring_agent");
    if (!agent) {
      return false;
    }
    const key = `operational:${code}`;
    const existing = await this.persistence.repos.memories.findByKey(key);
    if (existing) {
      return true;
    }
    const actor: Actor = {
      principalId: agent.id,
      principalType: "agent",
      role: "monitoring_agent",
      agentId: agent.id,
      departmentId: agent.departmentId,
      permissions: permissionsForRole("monitoring_agent"),
    };
    await this.createMemory(
      { actor, correlationId: `monitoring:${code}` },
      {
        scope: "agent",
        category: "operational",
        ownerAgentId: agent.id,
        departmentId: agent.departmentId,
        title: code,
        summary,
        content: summary,
        provenance: "system_observed",
        idempotencyKey: key,
      },
    );
    return false;
  }

  private async mergeGroup(ctx: RequestContext, rows: MemoryRow[], applyNear: boolean) {
    const ordered = [...rows].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const keeper = ordered[0];
    const rest = ordered.slice(1);
    if (!keeper) {
      return { applied: false, record: null };
    }
    const sameHash = rest.every((row) => row.contentHash === keeper.contentHash);
    if (!sameHash && !applyNear) {
      return { applied: false, record: null };
    }
    if (!sameHash) {
      const keeperVector = await this.persistence.repos.memories.getEmbedding(keeper.id);
      for (const row of rest) {
        if (await this.persistence.repos.memories.contradicts(keeper.id, row.id)) {
          throw new DomainError("INVALID_STATE", "Contradictory memories are not merged", 409);
        }
        const vector = await this.persistence.repos.memories.getEmbedding(row.id);
        if (!keeperVector || !vector || cosineSimilarity(keeperVector, vector) < this.limits.nearDuplicateCosine) {
          const proposal = {
            id: randomUUID(),
            keeperId: keeper.id,
            mergedIds: rest.map((item) => item.id),
            kind: "near" as const,
            createdAt: this.now().toISOString(),
          };
          return { applied: false, record: proposal };
        }
      }
    }
    const id = randomUUID();
    const mergedIds = rest.map((row) => row.id);
    await this.persistence.transaction(async (repos) => {
      for (const row of rest) {
        if (await this.reaches(repos.memories, row.id, keeper.id) || await this.reaches(repos.memories, keeper.id, row.id)) {
          throw new DomainError("INVALID_STATE", "Supersession would form a cycle", 409);
        }
        await repos.memories.update(row.id, { status: "superseded", supersededBy: keeper.id, updatedAt: this.now() });
        const revisions = await repos.memories.listRevisions(row.id);
        await repos.memories.insertRevision({
          id: randomUUID(),
          memoryId: row.id,
          revision: revisions.length + 1,
          status: "superseded",
          summary: row.summary,
          createdAt: this.now(),
        });
        await repos.memories.insertSource({
          id: randomUUID(),
          memoryId: keeper.id,
          objectiveId: null,
          taskId: null,
          messageId: null,
          sourceMemoryId: row.id,
          note: sameHash ? "exact-duplicate" : "near-duplicate",
        });
      }
      await repos.memories.insertConsolidation({
        id,
        keeperId: keeper.id,
        mergedIds,
        kind: sameHash ? "exact" : "near",
        createdAt: this.now(),
      });
      await repos.audit.append({
        eventType: "memory.consolidated",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory",
        targetId: keeper.id,
        action: "memory.consolidated",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { mergedIds, kind: sameHash ? "exact" : "near" },
        metadata: {},
      });
    });
    return {
      applied: true,
      record: { id, keeperId: keeper.id, mergedIds, kind: sameHash ? "exact" as const : "near" as const, createdAt: this.now().toISOString() },
    };
  }

  private async reaches(repos: MemoryRepository, start: string, target: string): Promise<boolean> {
    let cursor: string | null = start;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === target) {
        return true;
      }
      if (seen.has(cursor)) {
        return true;
      }
      seen.add(cursor);
      const row: MemoryRow | null = await repos.findById(cursor);
      cursor = row?.supersededBy ?? null;
    }
    return false;
  }

  private async changeStatus(ctx: RequestContext, memory: MemoryRow, status: MemoryRow["status"]) {
    await this.persistence.transaction(async (repos) => {
      await repos.memories.update(memory.id, { status, updatedAt: this.now() });
      const revisions = await repos.memories.listRevisions(memory.id);
      await repos.memories.insertRevision({
        id: randomUUID(),
        memoryId: memory.id,
        revision: revisions.length + 1,
        status,
        summary: memory.summary,
        createdAt: this.now(),
      });
      await repos.audit.append({
        eventType: "memory.archived",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "memory",
        targetId: memory.id,
        action: "memory.archived",
        correlationId: ctx.correlationId,
        beforeState: { status: memory.status },
        afterState: { status },
        metadata: {},
      });
    });
  }

  private async embed(memoryId: string, text: string): Promise<void> {
    const started = Date.now();
    try {
      const vector = await this.embeddings.embedText(text);
      this.assertVector(vector.values, vector.model);
      await this.persistence.repos.memories.saveEmbedding({
        memoryId,
        model: vector.model,
        dimensions: vector.dimensions,
        values: vector.values,
      });
      await this.persistence.repos.memories.recordEmbeddingUse({
        id: randomUUID(),
        model: vector.model,
        vectorCount: 1,
        latencyMs: Date.now() - started,
        success: true,
        error: null,
        createdAt: this.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "embedding failed";
      await this.persistence.repos.memories.update(memoryId, { embeddingError: message, updatedAt: this.now() });
      await this.persistence.repos.memories.recordEmbeddingUse({
        id: randomUUID(),
        model: this.embeddings.getModelInfo().model,
        vectorCount: 0,
        latencyMs: Date.now() - started,
        success: false,
        error: message,
        createdAt: this.now(),
      });
    }
  }

  private assertVector(values: number[], model: string): void {
    const expected = this.embeddings.getModelInfo();
    if (model !== expected.model || values.length !== expected.dimensions || values.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingError("bad_vector", `Embedding model ${model} did not return ${expected.dimensions} finite values`, false);
    }
  }

  private assertWritableScope(actor: Actor, scope: MemoryScope, ownerAgentId: string | null, departmentId: string | null): void {
    if (ROLE_PERMISSIONS[actor.role].has("memory:admin")) {
      return;
    }
    if (scope === "colony") {
      throw new DomainError("AUTHORIZATION_DENIED", "Colony memory is published only by an approved promotion", 403);
    }
    if (scope === "agent" && actor.agentId !== ownerAgentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Agent memory can be created only by its owner", 403);
    }
    if (scope === "department" && actor.departmentId !== departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Department memory is limited to that department", 403);
    }
  }

  private async requireVisible(actor: Actor, id: string): Promise<MemoryRow> {
    const memory = await this.persistence.repos.memories.findById(id);
    if (!memory || memory.status === "forgotten" || !canReadMemory(actor, memory)) {
      throw notFound("Memory", id);
    }
    return memory;
  }

  private assertVisible(actor: Actor, memory: MemoryRow): void {
    if (!canReadMemory(actor, memory)) {
      throw notFound("Memory", memory.id);
    }
  }

  private draft(id: string, ctx: RequestContext, input: MemoryCreate, key: string) {
    const ownerAgentId = input.scope === "agent" ? input.ownerAgentId ?? ctx.actor.agentId : null;
    const departmentId = input.scope === "colony" ? null : input.departmentId ?? ctx.actor.departmentId;
    return {
      id,
      scope: input.scope,
      category: input.category,
      ownerAgentId,
      departmentId,
      title: input.title,
      summary: input.summary,
      content: input.content,
      provenance: input.provenance,
      status: "candidate" as MemoryRow["status"],
      qualityScore: input.qualityScore ?? null,
      contentHash: hashContent(input.content),
      idempotencyKey: key,
      originAgentId: ctx.actor.agentId,
      createdBy: ctx.actor.principalId,
      createdAt: this.now(),
    };
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

function visibilityFor(actor: Actor): MemoryVisibility {
  const granted = ROLE_PERMISSIONS[actor.role];
  return {
    admin: granted.has("memory:admin"),
    agentId: actor.agentId,
    departmentId: actor.departmentId,
    canReadOwn: granted.has("memory:read:own"),
    canReadDepartment: granted.has("memory:read:department"),
    canReadColony: granted.has("memory:read:colony"),
  };
}

function publicMemory(memory: MemoryRow): MemoryRecord {
  return {
    id: memory.id,
    scope: memory.scope,
    category: memory.category,
    ownerAgentId: memory.ownerAgentId,
    departmentId: memory.departmentId,
    title: memory.title,
    summary: memory.summary,
    content: memory.content,
    provenance: memory.provenance,
    status: memory.status,
    qualityScore: memory.qualityScore,
    qualityCalibrated: false,
    embeddingModel: memory.embeddingModel,
    embeddingDimensions: memory.embeddingDimensions,
    contentHash: memory.contentHash,
    supersededBy: memory.supersededBy,
    originAgentId: memory.originAgentId,
    createdBy: memory.createdBy,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function publicPromotion(promotion: {
  id: string;
  memoryId: string;
  fromScope: MemoryRow["scope"];
  toScope: MemoryRow["scope"];
  status: "pending" | "approved" | "rejected";
  reason: string;
  proposedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  createdMemoryId: string | null;
  createdAt: string;
  decidedAt: string | null;
}): MemoryPromotion {
  return promotion;
}
