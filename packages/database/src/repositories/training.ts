import { randomUUID } from "node:crypto";
import { acceptanceCriteriaSchema, trainingConfigSchema, type TrainingRunStatus } from "@ai-colony/contracts";
import type {
  AdapterRecord,
  ArtifactRecord,
  CandidateRecord,
  DatasetVersionRecord,
  EvaluationRecord,
  ExampleRecord,
  TrainableRecord,
  TrainingRepository,
  TrainingRunRecord,
  TrainingSummary,
} from "@ai-colony/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../client.js";
import {
  candidateEvaluations,
  modelAdapters,
  modelCandidates,
  modelPromotionRequests,
  modelVersionEvents,
  trainableModels,
  trainingArtifacts,
  trainingDatasetVersions,
  trainingDatasets,
  trainingExamples,
  trainingRunMetrics,
  trainingRuns,
} from "../schema/index.js";

const ACTIVE: TrainingRunStatus[] = ["preparing", "training", "evaluating"];

export function createTrainingRepository(db: DbExecutor): TrainingRepository {
  return {
    async insertTrainable(input) {
      await db.insert(trainableModels).values({ ...input, kind: "trainable_checkpoint", compatibility: { adaptersTransferAcrossFamilies: false }, createdAt: new Date(input.createdAt) });
    },
    async findTrainable(id) {
      const [row] = await db.select().from(trainableModels).where(eq(trainableModels.id, id)).limit(1);
      return row ? mapTrainable(row) : null;
    },
    async findTrainableBySha(registryModelId, sha256) {
      const [row] = await db.select().from(trainableModels).where(and(eq(trainableModels.registryModelId, registryModelId), eq(trainableModels.sha256, sha256))).limit(1);
      return row ? mapTrainable(row) : null;
    },
    async listTrainable() {
      const rows = await db.select().from(trainableModels).orderBy(desc(trainableModels.createdAt));
      return rows.map(mapTrainable);
    },
    async findDatasetByKey(key) {
      const [row] = await joinedDatasets(db).where(eq(trainingDatasets.idempotencyKey, key)).limit(1);
      return row ? mapVersion(row) : null;
    },
    async insertDataset(input) {
      await db.insert(trainingDatasets).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async insertVersion(input) {
      await db.insert(trainingDatasetVersions).values({
        id: input.id,
        datasetId: input.datasetId,
        version: input.version,
        contentHash: input.contentHash,
        splitSeed: input.splitSeed,
        status: input.status,
        trainCount: input.trainCount,
        validationCount: input.validationCount,
        testCount: input.testCount,
        criteria: input.criteria,
        createdAt: new Date(input.createdAt),
      });
    },
    async insertExamples(rows) {
      if (rows.length === 0) {
        return;
      }
      await db.insert(trainingExamples).values(
        rows.map((row) => ({
          id: row.id,
          versionId: row.versionId,
          split: row.split,
          groupKey: row.groupKey,
          source: row.source,
          license: row.license,
          inputText: row.input,
          expectedOutput: row.expectedOutput,
          validationStatus: row.validationStatus,
          sourceMemoryId: row.sourceMemoryId,
          sourceObjectiveId: row.sourceObjectiveId,
          contentHash: row.contentHash,
          createdAt: new Date(),
        })),
      );
    },
    async getVersion(id) {
      const [row] = await joinedDatasets(db).where(eq(trainingDatasetVersions.id, id)).limit(1);
      return row ? mapVersion(row) : null;
    },
    async listExamples(versionId) {
      const rows = await db.select().from(trainingExamples).where(eq(trainingExamples.versionId, versionId)).orderBy(asc(trainingExamples.groupKey));
      return rows.map(mapExample);
    },
    async listDatasets() {
      const rows = await joinedDatasets(db).orderBy(desc(trainingDatasets.createdAt)).limit(100);
      return rows.map(mapVersion);
    },
    async listTestGroupKeys() {
      const rows = await db.select({ groupKey: trainingExamples.groupKey }).from(trainingExamples).where(eq(trainingExamples.split, "test"));
      return rows.map((row) => row.groupKey);
    },
    async insertRun(input) {
      await db.insert(trainingRuns).values({
        ...input,
        approvedAt: input.approvedAt ? new Date(input.approvedAt) : null,
        startedAt: input.startedAt ? new Date(input.startedAt) : null,
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
        createdAt: new Date(input.createdAt),
        updatedAt: new Date(input.createdAt),
      });
    },
    async findRun(id) {
      const [row] = await db.select().from(trainingRuns).where(eq(trainingRuns.id, id)).limit(1);
      return row ? mapRun(row) : null;
    },
    async findRunByKey(key) {
      const [row] = await db.select().from(trainingRuns).where(eq(trainingRuns.idempotencyKey, key)).limit(1);
      return row ? mapRun(row) : null;
    },
    async listRuns() {
      const rows = await db.select().from(trainingRuns).orderBy(desc(trainingRuns.createdAt)).limit(100);
      return rows.map(mapRun);
    },
    async updateRun(id, patch) {
      const [row] = await db
        .update(trainingRuns)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.cancelRequested !== undefined ? { cancelRequested: patch.cancelRequested } : {}),
          ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
          ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt ? new Date(patch.approvedAt) : null } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt ? new Date(patch.startedAt) : null } : {}),
          ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null } : {}),
          ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
          updatedAt: patch.updatedAt ? new Date(patch.updatedAt) : new Date(),
        })
        .where(eq(trainingRuns.id, id))
        .returning();
      if (!row) {
        throw new Error(`training run ${id} was not updated`);
      }
      return mapRun(row);
    },
    async claimIfIdle(id, at) {
      await db.execute(sql`select pg_advisory_xact_lock(54001)`);
      const [active] = await db.select({ n: sql<number>`count(*)::int` }).from(trainingRuns).where(inArray(trainingRuns.status, ACTIVE));
      if (Number(active?.n ?? 0) >= 1) {
        return "busy";
      }
      const [row] = await db
        .update(trainingRuns)
        .set({ status: "preparing", startedAt: new Date(at), updatedAt: new Date(at) })
        .where(and(eq(trainingRuns.id, id), eq(trainingRuns.status, "queued")))
        .returning();
      return row ? mapRun(row) : "unavailable";
    },
    async listActiveJobs() {
      const rows = await db.select().from(trainingRuns).where(inArray(trainingRuns.status, ACTIVE));
      return rows.map(mapRun);
    },
    async insertMetric(input) {
      await db.insert(trainingRunMetrics).values({ ...input, recordedAt: new Date(input.recordedAt) });
    },
    async listMetrics(runId) {
      const rows = await db.select().from(trainingRunMetrics).where(eq(trainingRunMetrics.runId, runId)).orderBy(asc(trainingRunMetrics.step));
      return rows.map((row) => ({
        step: row.step,
        trainLoss: row.trainLoss,
        validationLoss: row.validationLoss,
        learningRate: row.learningRate,
        recordedAt: row.recordedAt.toISOString(),
      }));
    },
    async insertArtifact(input) {
      await db.insert(trainingArtifacts).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async listArtifacts(runId) {
      const rows = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.runId, runId)).orderBy(asc(trainingArtifacts.createdAt));
      return rows.map(mapArtifact);
    },
    async artifactBytes() {
      const [row] = await db.select({ n: sql<number>`coalesce(sum(${trainingArtifacts.byteSize}), 0)::int` }).from(trainingArtifacts);
      return Number(row?.n ?? 0);
    },
    async insertAdapter(input) {
      await db.insert(modelAdapters).values({ ...input, createdAt: new Date(input.createdAt) });
    },
    async findAdapter(id) {
      const [row] = await db.select().from(modelAdapters).where(eq(modelAdapters.id, id)).limit(1);
      return row ? mapAdapter(row) : null;
    },
    async insertCandidate(input) {
      await db.insert(modelCandidates).values({ ...input, createdAt: new Date(input.createdAt), updatedAt: new Date(input.createdAt) });
    },
    async findCandidate(id) {
      const [row] = await db.select().from(modelCandidates).where(eq(modelCandidates.id, id)).limit(1);
      return row ? mapCandidate(row) : null;
    },
    async findCandidateByRun(runId) {
      const [row] = await db.select().from(modelCandidates).where(eq(modelCandidates.runId, runId)).limit(1);
      return row ? mapCandidate(row) : null;
    },
    async listCandidates() {
      const rows = await db.select().from(modelCandidates).orderBy(desc(modelCandidates.createdAt)).limit(100);
      return rows.map(mapCandidate);
    },
    async updateCandidate(id, status, at) {
      await db.update(modelCandidates).set({ status, updatedAt: new Date(at) }).where(eq(modelCandidates.id, id));
    },
    async insertEvaluation(input) {
      await db.insert(candidateEvaluations).values({
        ...input,
        baseline: JSON.parse(JSON.stringify(input.baseline)) as Record<string, unknown>,
        candidate: JSON.parse(JSON.stringify(input.candidate)) as Record<string, unknown>,
        createdAt: new Date(input.createdAt),
      });
    },
    async findEvaluation(candidateId) {
      const [row] = await db.select().from(candidateEvaluations).where(eq(candidateEvaluations.candidateId, candidateId)).limit(1);
      return row ? mapEvaluation(row) : null;
    },
    async insertPromotion(input) {
      await db.insert(modelPromotionRequests).values({
        ...input,
        createdAt: new Date(input.createdAt),
        decidedAt: input.decidedAt ? new Date(input.decidedAt) : null,
      });
    },
    async summary() {
      const runs = await db.select({ status: trainingRuns.status, n: sql<number>`count(*)::int` }).from(trainingRuns).groupBy(trainingRuns.status);
      const counts = new Map(runs.map((row) => [row.status, Number(row.n)]));
      const [datasets] = await db.select({ n: sql<number>`count(*)::int` }).from(trainingDatasets);
      const [examples] = await db.select({ n: sql<number>`count(*)::int` }).from(trainingExamples);
      const [bytes] = await db.select({ n: sql<number>`coalesce(sum(${trainingArtifacts.byteSize}), 0)::int` }).from(trainingArtifacts);
      const candidates = await db.select({ status: modelCandidates.status, n: sql<number>`count(*)::int` }).from(modelCandidates).groupBy(modelCandidates.status);
      const candidateCounts = new Map(candidates.map((row) => [row.status, Number(row.n)]));
      const summary: TrainingSummary = {
        queued: (counts.get("proposed") ?? 0) + (counts.get("awaiting_approval") ?? 0) + (counts.get("queued") ?? 0),
        active: (counts.get("preparing") ?? 0) + (counts.get("training") ?? 0) + (counts.get("evaluating") ?? 0),
        completed: counts.get("completed") ?? 0,
        failed: counts.get("failed") ?? 0,
        cancelled: counts.get("cancelled") ?? 0,
        datasets: Number(datasets?.n ?? 0),
        examples: Number(examples?.n ?? 0),
        artifactBytes: Number(bytes?.n ?? 0),
        candidatesApproved: candidateCounts.get("approved") ?? 0,
        candidatesRejected: candidateCounts.get("rejected") ?? 0,
      };
      return summary;
    },
    async insertEvent(input) {
      await db.insert(modelVersionEvents).values({ ...input, id: input.id || randomUUID(), createdAt: new Date(input.createdAt) });
    },
  };
}

function joinedDatasets(db: DbExecutor) {
  return db
    .select({
      version: trainingDatasetVersions,
      dataset: trainingDatasets,
    })
    .from(trainingDatasetVersions)
    .innerJoin(trainingDatasets, eq(trainingDatasets.id, trainingDatasetVersions.datasetId));
}

type TrainableRow = typeof trainableModels.$inferSelect;
type RunRow = typeof trainingRuns.$inferSelect;
type JoinedVersion = { version: typeof trainingDatasetVersions.$inferSelect; dataset: typeof trainingDatasets.$inferSelect };

function mapTrainable(row: TrainableRow): TrainableRecord {
  return {
    id: row.id,
    registryModelId: row.registryModelId,
    displayName: row.displayName,
    modelFamily: row.modelFamily,
    source: row.source,
    revision: row.revision,
    parameterCount: row.parameterCount,
    precision: row.precision,
    architecture: row.architecture,
    tokenizerId: row.tokenizerId,
    contextLength: row.contextLength,
    framework: row.framework,
    frameworkVersion: row.frameworkVersion,
    artifactUri: row.artifactUri,
    sha256: row.sha256,
    license: row.license,
    availableLocally: row.availableLocally,
    eligibleForTraining: row.eligibleForTraining,
    servingReady: row.servingReady,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapVersion(row: JoinedVersion): DatasetVersionRecord {
  return {
    id: row.version.id,
    datasetId: row.version.datasetId,
    name: row.dataset.name,
    taskDomain: row.dataset.taskDomain,
    version: row.version.version,
    contentHash: row.version.contentHash,
    splitSeed: row.version.splitSeed,
    status: "sealed",
    trainCount: row.version.trainCount,
    validationCount: row.version.validationCount,
    testCount: row.version.testCount,
    criteria: acceptanceCriteriaSchema.parse(row.version.criteria),
    createdBy: row.dataset.createdBy,
    createdAt: row.version.createdAt.toISOString(),
  };
}

function mapExample(row: typeof trainingExamples.$inferSelect): ExampleRecord {
  return {
    id: row.id,
    versionId: row.versionId,
    split: row.split as ExampleRecord["split"],
    groupKey: row.groupKey,
    source: row.source as ExampleRecord["source"],
    license: row.license,
    input: row.inputText,
    expectedOutput: row.expectedOutput,
    validationStatus: "verified",
    sourceMemoryId: row.sourceMemoryId,
    sourceObjectiveId: row.sourceObjectiveId,
    contentHash: row.contentHash,
  };
}

function mapRun(row: RunRow): TrainingRunRecord {
  return {
    id: row.id,
    datasetVersionId: row.datasetVersionId,
    trainableModelId: row.trainableModelId,
    parentRunId: row.parentRunId,
    profile: trainingConfigSchema.shape.profile.parse(row.profile),
    status: row.status as TrainingRunStatus,
    idempotencyKey: row.idempotencyKey,
    seed: row.seed,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    config: trainingConfigSchema.parse(row.config),
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error,
    cancelRequested: row.cancelRequested,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapArtifact(row: typeof trainingArtifacts.$inferSelect): ArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as ArtifactRecord["kind"],
    relativePath: row.relativePath,
    sha256: row.sha256,
    byteSize: row.byteSize,
    format: row.format as ArtifactRecord["format"],
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapAdapter(row: typeof modelAdapters.$inferSelect): AdapterRecord {
  return {
    id: row.id,
    artifactId: row.artifactId,
    baseTrainableModelId: row.baseTrainableModelId,
    rank: row.rank,
    alpha: row.alpha,
    dropout: row.dropout,
    targetModules: row.targetModules,
    trainableParameters: row.trainableParameters,
    framework: row.framework,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapCandidate(row: typeof modelCandidates.$inferSelect): CandidateRecord {
  return {
    id: row.id,
    adapterId: row.adapterId,
    runId: row.runId,
    status: row.status as CandidateRecord["status"],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapEvaluation(row: typeof candidateEvaluations.$inferSelect): EvaluationRecord {
  return {
    id: row.id,
    candidateId: row.candidateId,
    runId: row.runId,
    baseline: row.baseline as unknown as EvaluationRecord["baseline"],
    candidate: row.candidate as unknown as EvaluationRecord["candidate"],
    acceptanceMet: row.acceptanceMet,
    criteria: acceptanceCriteriaSchema.parse(row.criteria),
    report: row.report,
    createdAt: row.createdAt.toISOString(),
  };
}
