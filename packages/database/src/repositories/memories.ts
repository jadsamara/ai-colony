import { EMBEDDING_DIMENSIONS } from "@ai-colony/contracts";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import type {
  MemoryPromotionRow,
  MemoryRepository,
  MemoryRevisionRow,
  MemoryRow,
  MemorySearchRow,
  MemorySourceRow,
  MemoryVisibility,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import {
  agents,
  memories,
  memoryConsolidationRecords,
  memoryContradictions,
  memoryEmbeddingUsage,
  memoryEmbeddings,
  memoryPromotionRequests,
  memoryRetrievalEvents,
  memoryRetrievalHits,
  memoryRevisions,
  memorySources,
} from "../schema/index.js";

const SCOPES = ["agent", "department", "colony"] as const;
const CATEGORIES = ["episodic", "semantic", "procedural", "failure", "operational"] as const;
const STATUSES = ["candidate", "validated", "disputed", "superseded", "archived", "expired", "forgetting_requested", "forgotten"] as const;

export function createMemoryRepository(db: DbExecutor): MemoryRepository {
  return {
    async insert(input) {
      const inserted = await db
        .insert(memories)
        .values({
          ...input,
          embeddingModel: null,
          embeddingDimensions: null,
          supersededBy: null,
          embeddingError: null,
          updatedAt: input.createdAt,
        })
        .onConflictDoNothing({ target: memories.idempotencyKey })
        .returning({ id: memories.id });
      return inserted.length === 0 ? "exists" : "created";
    },
    async findById(id) {
      const rows = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
      return rows[0] ? mapMemory(rows[0]) : null;
    },
    async tombstone(id, at) {
      await db
        .update(memories)
        .set({ title: "[forgotten]", summary: "[forgotten]", content: "", status: "forgotten", updatedAt: at })
        .where(eq(memories.id, id));
      await db.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, id));
      await db.update(memoryRevisions).set({ summary: "[forgotten]" }).where(eq(memoryRevisions.memoryId, id));
    },
    async retentionIds(input) {
      const filters = [sql`${memories.status} in ('candidate', 'validated')`, lt(memories.createdAt, input.olderThan)];
      if (input.scope) {
        filters.push(eq(memories.scope, input.scope));
      }
      if (input.provenance) {
        filters.push(eq(memories.provenance, input.provenance));
      }
      const rows = await db.select({ id: memories.id }).from(memories).where(and(...filters)).limit(100);
      return rows.map((row) => row.id);
    },
    async findByKey(key) {
      const rows = await db.select().from(memories).where(eq(memories.idempotencyKey, key)).limit(1);
      return rows[0] ? mapMemory(rows[0]) : null;
    },
    async update(id, patch) {
      await db.update(memories).set(patch).where(eq(memories.id, id));
    },
    async insertRevision(input) {
      await db.insert(memoryRevisions).values(input);
    },
    async listRevisions(memoryId) {
      const rows = await db
        .select()
        .from(memoryRevisions)
        .where(eq(memoryRevisions.memoryId, memoryId))
        .orderBy(memoryRevisions.revision);
      return rows.map((row) => ({
        id: row.id,
        memoryId: row.memoryId,
        revision: row.revision,
        status: row.status as MemoryRevisionRow["status"],
        summary: row.summary,
        createdAt: iso(row.createdAt),
      }));
    },
    async insertSource(input) {
      await db.insert(memorySources).values({ ...input, createdAt: new Date() });
    },
    async listSources(memoryId) {
      const rows = await db.select().from(memorySources).where(eq(memorySources.memoryId, memoryId));
      return rows.map(mapSource);
    },
    async countObjectiveSources(objectiveId) {
      const rows = await db
        .select({ id: memorySources.id })
        .from(memorySources)
        .where(eq(memorySources.objectiveId, objectiveId));
      return rows.length;
    },
    async saveEmbedding(input) {
      const literal = vectorLiteral(input.values);
      await db.execute(sql`
        insert into memory_embeddings (memory_id, model_name, dimensions, embedding)
        values (${input.memoryId}, ${input.model}, ${input.dimensions}, ${literal}::vector)
        on conflict (memory_id) do update
          set model_name = excluded.model_name,
              dimensions = excluded.dimensions,
              embedding = excluded.embedding
      `);
      await db
        .update(memories)
        .set({
          embeddingModel: input.model,
          embeddingDimensions: input.dimensions,
          embeddingError: null,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, input.memoryId));
    },
    async getEmbedding(memoryId) {
      const rows = await db.execute<{ embedding: string }>(sql`
        select embedding::text as embedding from memory_embeddings where memory_id = ${memoryId}
      `);
      const value = rows[0]?.embedding;
      return value ? parseVector(value) : null;
    },
    async search(input) {
      const literal = input.vector ? vectorLiteral(input.vector) : null;
      const scopes = input.scopes ?? [...SCOPES];
      const categories = input.categories ?? [...CATEGORIES];
      const rows = await db.execute(sql`
        select memories.*,
          case
            when ${literal}::text is null or memory_embeddings.embedding is null then null
            else 1 - (memory_embeddings.embedding <=> ${literal}::vector)
          end as vector_score,
          case
            when ${input.query} = '' then 0
            else ts_rank_cd(
              to_tsvector('english', coalesce(memories.summary, '') || ' ' || memories.content),
              plainto_tsquery('english', ${input.query})
            )
          end as keyword_score
        from memories
        left join memory_embeddings
          on memory_embeddings.memory_id = memories.id
          and memory_embeddings.model_name = ${input.embeddingModel}
          and memory_embeddings.dimensions = ${EMBEDDING_DIMENSIONS}
        where ${visibilitySql(input.visibility)}
          and memories.scope in (${sql.join(scopes.map((scope) => sql`${scope}`), sql`, `)})
          and memories.category in (${sql.join(categories.map((category) => sql`${category}`), sql`, `)})
          and memories.status in (${sql.join(input.statuses.map((status) => sql`${status}`), sql`, `)})
          and memories.status <> 'forgotten'
        limit ${input.limit}
      `);
      return [...rows].map((row) => mapSearch(row as unknown as SearchSql));
    },
    async list(input) {
      const statuses = input.status ? [input.status] : ["candidate", "validated", "disputed"];
      const filters = [
        visibilitySql(input.visibility),
        sql`${memories.status} in (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`,
        sql`${memories.status} <> 'forgotten'`,
      ];
      if (input.scope) {
        filters.push(eq(memories.scope, input.scope));
      }
      if (input.category) {
        filters.push(eq(memories.category, input.category));
      }
      if (input.cursor) {
        const cursor = or(
          lt(memories.createdAt, input.cursor.createdAt),
          and(eq(memories.createdAt, input.cursor.createdAt), lt(memories.id, input.cursor.id)),
        );
        if (cursor) {
          filters.push(cursor);
        }
      }
      const rows = await db
        .select()
        .from(memories)
        .where(and(...filters))
        .orderBy(desc(memories.createdAt), desc(memories.id))
        .limit(input.limit);
      return rows.map(mapMemory);
    },
    async exactGroup(hash, scope, category, ownerAgentId, departmentId) {
      const rows = await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.contentHash, hash),
            eq(memories.scope, scope),
            eq(memories.category, category),
            ownerAgentId ? eq(memories.ownerAgentId, ownerAgentId) : sql`${memories.ownerAgentId} is null`,
            departmentId ? eq(memories.departmentId, departmentId) : sql`${memories.departmentId} is null`,
          ),
        );
      return rows.map(mapMemory);
    },
    async insertPromotion(input) {
      await db.insert(memoryPromotionRequests).values(input);
    },
    async findPromotion(id) {
      const rows = await db.select().from(memoryPromotionRequests).where(eq(memoryPromotionRequests.id, id)).limit(1);
      return rows[0] ? mapPromotion(rows[0]) : null;
    },
    async listPromotions(limit) {
      const rows = await db
        .select()
        .from(memoryPromotionRequests)
        .orderBy(desc(memoryPromotionRequests.createdAt))
        .limit(limit);
      return rows.map(mapPromotion);
    },
    async decidePromotion(id, decision) {
      await db
        .update(memoryPromotionRequests)
        .set({
          status: decision.status,
          decidedBy: decision.decidedBy,
          decisionReason: decision.decisionReason,
          createdMemoryId: decision.createdMemoryId,
          decidedAt: decision.decidedAt,
        })
        .where(eq(memoryPromotionRequests.id, id));
    },
    async insertConsolidation(input) {
      await db.insert(memoryConsolidationRecords).values(input);
    },
    async linkContradiction(leftId, rightId, createdAt) {
      await db
        .insert(memoryContradictions)
        .values([
          { memoryId: leftId, otherMemoryId: rightId, createdAt },
          { memoryId: rightId, otherMemoryId: leftId, createdAt },
        ])
        .onConflictDoNothing();
    },
    async contradicts(leftId, rightId) {
      const rows = await db
        .select({ memoryId: memoryContradictions.memoryId })
        .from(memoryContradictions)
        .where(and(eq(memoryContradictions.memoryId, leftId), eq(memoryContradictions.otherMemoryId, rightId)))
        .limit(1);
      return rows.length > 0;
    },
    async recordRetrieval(input) {
      await db.insert(memoryRetrievalEvents).values({
        id: input.id,
        objectiveId: input.objectiveId,
        taskId: input.taskId,
        actorId: input.actorId,
        queryHash: input.queryHash,
        mode: input.mode,
        hitCount: input.hitCount,
        latencyMs: input.latencyMs,
        createdAt: input.createdAt,
      });
      if (input.hits.length > 0) {
        await db.insert(memoryRetrievalHits).values(
          input.hits.map((hit) => ({
            eventId: input.id,
            memoryId: hit.memoryId,
            rank: hit.rank,
            score: hit.score,
          })),
        );
      }
    },
    async recordEmbeddingUse(input) {
      await db.insert(memoryEmbeddingUsage).values({
        id: input.id,
        modelName: input.model,
        vectorCount: input.vectorCount,
        latencyMs: input.latencyMs,
        success: input.success,
        error: input.error,
        createdAt: input.createdAt,
      });
    },
    async metrics() {
      const counts = await db.execute<{ scope: string; category: string; status: string; count: number }>(sql`
        select scope, category, status, count(*)::int as count from memories group by scope, category, status
      `);
      const embedding = await db.execute<{ failures: number; latency: number | null }>(sql`
        select count(*) filter (where success = false)::int as failures,
               avg(latency_ms) filter (where success = true) as latency
        from memory_embedding_usage
      `);
      const retrieval = await db.execute<{ retrievals: number; hits: number; latency: number | null }>(sql`
        select count(*)::int as retrievals,
               count(*) filter (where hit_count > 0)::int as hits,
               avg(latency_ms) as latency
        from memory_retrieval_events
      `);
      const promotions = await db.execute<{ status: string; count: number }>(sql`
        select status, count(*)::int as count from memory_promotion_requests group by status
      `);
      const consolidations = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from memory_consolidation_records
      `);
      const byScope = zero(SCOPES);
      const byCategory = zero(CATEGORIES);
      const byStatus = zero(STATUSES);
      for (const row of counts) {
        byScope[row.scope as MemoryRow["scope"]] += Number(row.count);
        byCategory[row.category as MemoryRow["category"]] += Number(row.count);
        byStatus[row.status as MemoryRow["status"]] += Number(row.count);
      }
      const promotionCounts = { pending: 0, approved: 0, rejected: 0 };
      for (const row of promotions) {
        if (row.status === "pending" || row.status === "approved" || row.status === "rejected") {
          promotionCounts[row.status] = Number(row.count);
        }
      }
      return {
        byScope,
        byCategory,
        byStatus,
        embeddingFailures: Number(embedding[0]?.failures ?? 0),
        meanEmbeddingLatencyMs: numberOrNull(embedding[0]?.latency),
        retrievals: Number(retrieval[0]?.retrievals ?? 0),
        retrievalHits: Number(retrieval[0]?.hits ?? 0),
        meanRetrievalLatencyMs: numberOrNull(retrieval[0]?.latency),
        promotions: promotionCounts,
        consolidations: Number(consolidations[0]?.count ?? 0),
      };
    },
    async findAgentByRole(role) {
      const rows = await db
        .select({ id: agents.id, departmentId: agents.departmentId, role: agents.roleName })
        .from(agents)
        .where(eq(agents.roleName, role))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

function visibilitySql(visibility: MemoryVisibility): SQL {
  return sql`(
    ${visibility.admin} = true
    or (${memories.scope} = 'agent' and ${memories.ownerAgentId} = ${visibility.agentId} and ${visibility.canReadOwn} = true)
    or (${memories.scope} = 'department' and ${memories.departmentId} = ${visibility.departmentId} and ${visibility.canReadDepartment} = true)
    or (${memories.scope} = 'colony' and ${visibility.canReadColony} = true)
  )`;
}

function vectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding vector is not a finite 768-dimensional value");
  }
  return `[${values.join(",")}]`;
}

function parseVector(value: string): number[] {
  return value
    .replace("[", "")
    .replace("]", "")
    .split(",")
    .filter((part) => part.length > 0)
    .map(Number);
}

function mapMemory(row: typeof memories.$inferSelect): MemoryRow {
  return {
    id: row.id,
    scope: row.scope as MemoryRow["scope"],
    category: row.category as MemoryRow["category"],
    ownerAgentId: row.ownerAgentId,
    departmentId: row.departmentId,
    title: row.title,
    summary: row.summary,
    content: row.content,
    provenance: row.provenance as MemoryRow["provenance"],
    status: row.status as MemoryRow["status"],
    qualityScore: row.qualityScore,
    embeddingModel: row.embeddingModel,
    embeddingDimensions: row.embeddingDimensions,
    contentHash: row.contentHash,
    idempotencyKey: row.idempotencyKey,
    supersededBy: row.supersededBy,
    originAgentId: row.originAgentId,
    createdBy: row.createdBy,
    embeddingError: row.embeddingError,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mapSource(row: typeof memorySources.$inferSelect): MemorySourceRow {
  return {
    id: row.id,
    memoryId: row.memoryId,
    objectiveId: row.objectiveId,
    taskId: row.taskId,
    messageId: row.messageId,
    sourceMemoryId: row.sourceMemoryId,
    note: row.note,
  };
}

function mapPromotion(row: typeof memoryPromotionRequests.$inferSelect): MemoryPromotionRow {
  return {
    id: row.id,
    memoryId: row.memoryId,
    fromScope: row.fromScope as MemoryPromotionRow["fromScope"],
    toScope: row.toScope as MemoryPromotionRow["toScope"],
    status: row.status as MemoryPromotionRow["status"],
    reason: row.reason,
    proposedBy: row.proposedBy,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    createdMemoryId: row.createdMemoryId,
    createdAt: iso(row.createdAt),
    decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
  };
}

interface SearchSql {
  id: string;
  scope: MemoryRow["scope"];
  category: MemoryRow["category"];
  owner_agent_id: string | null;
  department_id: string | null;
  title: string;
  summary: string;
  content: string;
  provenance: MemoryRow["provenance"];
  status: MemoryRow["status"];
  quality_score: number | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  content_hash: string;
  idempotency_key: string;
  superseded_by: string | null;
  origin_agent_id: string | null;
  created_by: string;
  embedding_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  vector_score: number | null;
  keyword_score: number | null;
}

function mapSearch(row: SearchSql): MemorySearchRow {
  return {
    id: row.id,
    scope: row.scope,
    category: row.category,
    ownerAgentId: row.owner_agent_id,
    departmentId: row.department_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    provenance: row.provenance,
    status: row.status,
    qualityScore: numberOrNull(row.quality_score),
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    contentHash: row.content_hash,
    idempotencyKey: row.idempotency_key,
    supersededBy: row.superseded_by,
    originAgentId: row.origin_agent_id,
    createdBy: row.created_by,
    embeddingError: row.embedding_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    vectorScore: numberOrNull(row.vector_score),
    keywordScore: Number(row.keyword_score ?? 0),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function zero<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
