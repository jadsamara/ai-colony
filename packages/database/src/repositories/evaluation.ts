import { and, desc, eq, sql } from "drizzle-orm";
import type {
  BenchmarkItemRecord,
  BenchmarkSuiteRecord,
  BenchmarkVersionRecord,
  EvaluationRepository,
  EvaluationResultRecord,
  EvaluationRunRecord,
  ForgettingRecord,
  GateRecord,
  RollbackRecord,
  RouteRecord,
  RouteVersionRecord,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import {
  artifactContamination,
  benchmarkItems,
  benchmarkSuites,
  benchmarkVersions,
  candidateGateDecisions,
  evaluationItemResults,
  evaluationReports,
  evaluationRuns,
  experimentalRouteVersions,
  experimentalRoutes,
  forgettingRequests,
  lineageEdges,
  memoryEmbeddings,
  memoryPromotionRequests,
  memoryRevisions,
  memorySources,
  modelCandidates,
  retentionPolicies,
  rollbackRequests,
  trainingArtifacts,
  trainingExamples,
  trainingRuns,
} from "../schema/index.js";

function iso(value: Date): string {
  return value.toISOString();
}

export function createEvaluationRepository(db: DbExecutor): EvaluationRepository {
  return {
    async insertSuite(input) {
      await db.insert(benchmarkSuites).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async listSuites() {
      const rows = await db.select().from(benchmarkSuites).orderBy(desc(benchmarkSuites.createdAt));
      return rows.map(mapSuite);
    },
    async findSuite(id) {
      const [row] = await db.select().from(benchmarkSuites).where(eq(benchmarkSuites.id, id)).limit(1);
      return row ? mapSuite(row) : null;
    },
    async findSuiteBySlug(slug) {
      const [row] = await db.select().from(benchmarkSuites).where(eq(benchmarkSuites.slug, slug)).limit(1);
      return row ? mapSuite(row) : null;
    },
    async insertVersion(input) {
      await db.insert(benchmarkVersions).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async findVersion(id) {
      const [row] = await db.select().from(benchmarkVersions).where(eq(benchmarkVersions.id, id)).limit(1);
      return row ? mapVersion(row) : null;
    },
    async listVersions(suiteId) {
      const rows = await db.select().from(benchmarkVersions).where(eq(benchmarkVersions.suiteId, suiteId)).orderBy(benchmarkVersions.version);
      return rows.map(mapVersion);
    },
    async publishVersion(id, approvedBy) {
      await db.update(benchmarkVersions).set({ status: "published", approvedBy }).where(and(eq(benchmarkVersions.id, id), eq(benchmarkVersions.status, "draft")));
    },
    async insertItems(items) {
      if (items.length === 0) {
        return;
      }
      await db.insert(benchmarkItems).values(items);
    },
    async listItems(versionId) {
      const rows = await db.select().from(benchmarkItems).where(eq(benchmarkItems.versionId, versionId)).orderBy(benchmarkItems.ordinal);
      return rows.map(mapItem);
    },
    async sealedPromptHashes() {
      const rows = await db.select({ promptHash: benchmarkItems.promptHash }).from(benchmarkItems).where(eq(benchmarkItems.sealed, true));
      return rows.map((row) => row.promptHash);
    },
    async insertRun(input) {
      await db.insert(evaluationRuns).values({ ...input, createdAt: new Date(input.createdAt), finishedAt: input.finishedAt ? new Date(input.finishedAt) : null });
    },
    async findRun(id) {
      const [row] = await db.select().from(evaluationRuns).where(eq(evaluationRuns.id, id)).limit(1);
      return row ? mapRun(row) : null;
    },
    async insertResults(rows) {
      if (rows.length === 0) {
        return;
      }
      await db.insert(evaluationItemResults).values(rows);
    },
    async listResults(runId) {
      const rows = await db.select().from(evaluationItemResults).where(eq(evaluationItemResults.runId, runId)).orderBy(evaluationItemResults.ordinal);
      return rows.map(mapResult);
    },
    async insertReport(input) {
      await db.insert(evaluationReports).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async findReportByRun(runId) {
      const [row] = await db.select().from(evaluationReports).where(eq(evaluationReports.runId, runId)).limit(1);
      return row ? { id: row.id, runId: row.runId, summary: row.summary, createdAt: iso(row.createdAt) } : null;
    },
    async insertGate(input) {
      await db.insert(candidateGateDecisions).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async listGates(candidateId) {
      const rows = await db.select().from(candidateGateDecisions).where(eq(candidateGateDecisions.candidateId, candidateId)).orderBy(candidateGateDecisions.createdAt);
      return rows.map((row) => ({ ...row, decision: row.decision as GateRecord["decision"], createdAt: iso(row.createdAt) }));
    },
    async insertRoute(input) {
      await db.insert(experimentalRoutes).values({ ...input, updatedAt: new Date(input.updatedAt) });
    },
    async findRoute(id) {
      const [row] = await db.select().from(experimentalRoutes).where(eq(experimentalRoutes.id, id)).limit(1);
      return row ? mapRoute(row) : null;
    },
    async findRouteBySlug(slug) {
      const [row] = await db.select().from(experimentalRoutes).where(eq(experimentalRoutes.slug, slug)).limit(1);
      return row ? mapRoute(row) : null;
    },
    async listRoutes() {
      const rows = await db.select().from(experimentalRoutes).orderBy(experimentalRoutes.slug);
      return rows.map(mapRoute);
    },
    async setRouteVersion(id, version, at) {
      await db.update(experimentalRoutes).set({ currentVersion: version, updatedAt: new Date(at) }).where(eq(experimentalRoutes.id, id));
    },
    async insertRouteVersion(input) {
      await db.insert(experimentalRouteVersions).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async listRouteVersions(routeId) {
      const rows = await db.select().from(experimentalRouteVersions).where(eq(experimentalRouteVersions.routeId, routeId)).orderBy(experimentalRouteVersions.version);
      return rows.map(mapRouteVersion);
    },
    async findRouteVersion(routeId, version) {
      const [row] = await db
        .select()
        .from(experimentalRouteVersions)
        .where(and(eq(experimentalRouteVersions.routeId, routeId), eq(experimentalRouteVersions.version, version)))
        .limit(1);
      return row ? mapRouteVersion(row) : null;
    },
    async insertRollback(input) {
      await db.insert(rollbackRequests).values({
        ...input,
        createdAt: new Date(input.createdAt),
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
      });
    },
    async findRollback(id) {
      const [row] = await db.select().from(rollbackRequests).where(eq(rollbackRequests.id, id)).limit(1);
      return row ? mapRollback(row) : null;
    },
    async updateRollback(id, patch) {
      await db
        .update(rollbackRequests)
        .set({
          ...patch,
          finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : undefined,
        })
        .where(eq(rollbackRequests.id, id));
    },
    async insertRetention(input) {
      await db.insert(retentionPolicies).values({ ...input, status: "published", createdAt: new Date(input.createdAt) });
    },
    async listRetention() {
      const rows = await db.select().from(retentionPolicies).orderBy(desc(retentionPolicies.createdAt));
      return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
    },
    async insertForgetting(input) {
      await db.insert(forgettingRequests).values({ ...input, createdAt: new Date(input.createdAt), finishedAt: input.finishedAt ? new Date(input.finishedAt) : null });
    },
    async findForgetting(id) {
      const [row] = await db.select().from(forgettingRequests).where(eq(forgettingRequests.id, id)).limit(1);
      return row ? mapForgetting(row) : null;
    },
    async findForgettingByKey(key) {
      const [row] = await db.select().from(forgettingRequests).where(eq(forgettingRequests.idempotencyKey, key)).limit(1);
      return row ? mapForgetting(row) : null;
    },
    async updateForgetting(id, patch) {
      await db
        .update(forgettingRequests)
        .set({ ...patch, finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : undefined })
        .where(eq(forgettingRequests.id, id));
    },
    async memoryImpact(memoryId) {
      const [revisions] = await db.select({ count: sql<number>`count(*)::int` }).from(memoryRevisions).where(eq(memoryRevisions.memoryId, memoryId));
      const [embedding] = await db.select({ memoryId: memoryEmbeddings.memoryId }).from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, memoryId)).limit(1);
      const derived = await db.select({ id: memorySources.memoryId }).from(memorySources).where(eq(memorySources.sourceMemoryId, memoryId));
      const copies = await db
        .select({ id: memoryPromotionRequests.createdMemoryId })
        .from(memoryPromotionRequests)
        .where(eq(memoryPromotionRequests.memoryId, memoryId));
      const examples = await db
        .select({ id: trainingExamples.id, versionId: trainingExamples.versionId })
        .from(trainingExamples)
        .where(eq(trainingExamples.sourceMemoryId, memoryId));
      const versionIds = [...new Set(examples.map((row) => row.versionId))];
      const artifacts =
        versionIds.length === 0
          ? []
          : await db
              .select({ id: trainingArtifacts.id })
              .from(trainingArtifacts)
              .innerJoin(trainingRuns, eq(trainingRuns.id, trainingArtifacts.runId))
              .where(sql`${trainingRuns.datasetVersionId} in (${sql.join(versionIds.map((id) => sql`${id}`), sql`, `)})`);
      return {
        revisionCount: Number(revisions?.count ?? 0),
        embeddingPresent: Boolean(embedding),
        derivedMemoryIds: derived.map((row) => row.id),
        promotionCopyIds: copies.map((row) => row.id).filter((id): id is string => id !== null),
        exampleIds: examples.map((row) => row.id),
        datasetVersionIds: versionIds,
        artifactIds: artifacts.map((row) => row.id),
        relation: examples.length > 0 ? "definitely_used" : "not_used",
      };
    },
    async insertLineage(input) {
      await db.insert(lineageEdges).values({ ...input, createdAt: new Date(input.createdAt) }).onConflictDoNothing();
    },
    async contaminate(input) {
      await db.insert(artifactContamination).values({ ...input, createdAt: new Date(input.createdAt) }).onConflictDoNothing();
    },
    async isArtifactContaminated(artifactId) {
      const [row] = await db.select({ id: artifactContamination.id }).from(artifactContamination).where(eq(artifactContamination.artifactId, artifactId)).limit(1);
      return Boolean(row);
    },
    async summary() {
      const [failed] = await db.select({ count: sql<number>`count(*)::int` }).from(evaluationRuns).where(eq(evaluationRuns.status, "failed"));
      const [gates] = await db.select({ count: sql<number>`count(*)::int` }).from(candidateGateDecisions).where(eq(candidateGateDecisions.decision, "FAIL"));
      const [quarantine] = await db.select({ count: sql<number>`count(*)::int` }).from(modelCandidates).where(eq(modelCandidates.status, "quarantined"));
      const [contaminated] = await db.select({ count: sql<number>`count(*)::int` }).from(artifactContamination);
      const [openForget] = await db.select({ count: sql<number>`count(*)::int` }).from(forgettingRequests).where(sql`${forgettingRequests.status} in ('requested', 'approved')`);
      const [rollbackFailed] = await db.select({ count: sql<number>`count(*)::int` }).from(rollbackRequests).where(eq(rollbackRequests.status, "failed"));
      return {
        failedRuns: Number(failed?.count ?? 0),
        gateFailures: Number(gates?.count ?? 0),
        quarantined: Number(quarantine?.count ?? 0),
        contaminatedArtifacts: Number(contaminated?.count ?? 0),
        forgettingOpen: Number(openForget?.count ?? 0),
        rollbackFailures: Number(rollbackFailed?.count ?? 0),
      };
    },
  };
}

function mapSuite(row: typeof benchmarkSuites.$inferSelect): BenchmarkSuiteRecord {
  return { ...row, createdAt: iso(row.createdAt) };
}

function mapVersion(row: typeof benchmarkVersions.$inferSelect): BenchmarkVersionRecord {
  return { ...row, status: row.status as BenchmarkVersionRecord["status"], createdAt: iso(row.createdAt) };
}

function mapItem(row: typeof benchmarkItems.$inferSelect): BenchmarkItemRecord {
  return row;
}

function mapRun(row: typeof evaluationRuns.$inferSelect): EvaluationRunRecord {
  return {
    ...row,
    source: row.source as EvaluationRunRecord["source"],
    status: row.status as EvaluationRunRecord["status"],
    createdAt: iso(row.createdAt),
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
  };
}

function mapResult(row: typeof evaluationItemResults.$inferSelect): EvaluationResultRecord {
  return { ...row, role: row.role as EvaluationResultRecord["role"] };
}

function mapRoute(row: typeof experimentalRoutes.$inferSelect): RouteRecord {
  return { ...row, updatedAt: iso(row.updatedAt) };
}

function mapRouteVersion(row: typeof experimentalRouteVersions.$inferSelect): RouteVersionRecord {
  return { ...row, kind: row.kind as RouteVersionRecord["kind"], createdAt: iso(row.createdAt) };
}

function mapRollback(row: typeof rollbackRequests.$inferSelect): RollbackRecord {
  return {
    ...row,
    status: row.status as RollbackRecord["status"],
    createdAt: iso(row.createdAt),
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
  };
}

function mapForgetting(row: typeof forgettingRequests.$inferSelect): ForgettingRecord {
  return {
    ...row,
    status: row.status as ForgettingRecord["status"],
    createdAt: iso(row.createdAt),
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
  };
}
