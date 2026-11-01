import type { ExperimentRepository, StoredExperiment } from "@ai-colony/core";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../client.js";
import { trainingExperiments } from "../schema/index.js";

function map(row: typeof trainingExperiments.$inferSelect): StoredExperiment {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    methodId: row.methodId,
    modelId: row.modelId,
    modelRevision: row.modelRevision,
    adapterSha256: row.adapterSha256,
    problem: row.problem,
    datasetSize: row.datasetSize,
    learningRate: row.learningRate,
    steps: row.steps,
    exposures: row.exposures,
    target: row.target === "structured" ? "structured" : "answer",
    seed: row.seed,
    devAccuracy: row.devAccuracy,
    baselineAccuracy: row.baselineAccuracy,
    sealedAccuracy: row.sealedAccuracy,
    retentionOk: row.retentionOk,
    failureClass: row.failureClass,
    recommendation: row.recommendation,
    evidencePath: row.evidencePath,
    stopped: row.stopped,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createExperimentRepository(db: DbExecutor): ExperimentRepository {
  return {
    async insert(input) {
      const existing = await db.select().from(trainingExperiments).where(eq(trainingExperiments.idempotencyKey, input.idempotencyKey)).limit(1);
      const prior = existing[0];
      if (prior) {
        return map(prior);
      }
      const [row] = await db.insert(trainingExperiments).values({ ...input, createdAt: new Date(input.createdAt) }).returning();
      if (!row) {
        throw new Error("Experiment insert did not return a row");
      }
      return map(row);
    },
    async findByKey(key) {
      const [row] = await db.select().from(trainingExperiments).where(eq(trainingExperiments.idempotencyKey, key)).limit(1);
      return row ? map(row) : null;
    },
    async list() {
      const rows = await db.select().from(trainingExperiments).orderBy(trainingExperiments.createdAt);
      return rows.map(map);
    },
  };
}
