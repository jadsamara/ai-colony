import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "../packages/contracts/dist/index.js";
import {
  Authorizer,
  DEFAULT_MEMORY_LIMITS,
  DEFAULT_MESSAGING_POLICY,
  EvaluationService,
  IdentityService,
  MemoryService,
  MessagingService,
  MlxTrainingProvider,
} from "../packages/core/dist/index.js";
import { createDatabase, createPersistence } from "../packages/database/dist/index.js";
import { OllamaEmbeddingProvider } from "../packages/inference/dist/index.js";
import { sql } from "drizzle-orm";

const root = join(import.meta.dirname, "..");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("127.0.0.1:5433")) {
  throw new Error("DATABASE_URL must be the canonical Homebrew database on 127.0.0.1:5433");
}

const CANDIDATE_ID = "4c67ce90-ad8c-4b9b-9994-2a9454e915d7";
const M5_RUN_ID = "7979740a-f163-4a42-b6f8-aa697a108f67";
const PRODUCTION_MEMORY_ID = "0b74e350-cbd1-4f2b-a2f6-6f2d5e203df4";
const HOLDOUT = [
  { prompt: "0 + 1", expected: "1" },
  { prompt: "0 + 10", expected: "10" },
  { prompt: "0 + 7", expected: "7" },
  { prompt: "1 + 12", expected: "13" },
  { prompt: "2 + 7", expected: "9" },
];
const HISTORICAL = {
  baselineOutputs: ["0 + 1 = 1", "0 + 10 = 1", "0 + 7 = 7", "1 + 12 = 1", "2 + 7 = 9"],
  candidateOutputs: ["11", "10", "11", "15", "19"],
};

const { db, close } = createDatabase(databaseUrl);
const persistence = createPersistence(db, close);
const authorizer = new Authorizer();
const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY);
const roots = {
  artifacts: join(root, "services/training/artifacts"),
  checkpoints: join(root, "services/training/checkpoints"),
};
const provider = new MlxTrainingProvider({ pythonPath: join(root, "services/training/.venv/bin/python"), scriptsDir: join(root, "services/training") });
const evaluation = new EvaluationService(persistence, authorizer, provider, messages, roots);
const embeddings = new OllamaEmbeddingProvider({
  baseUrl: process.env.EMBEDDING_BASE_URL ?? "http://127.0.0.1:11434",
  model: process.env.EMBEDDING_MODEL ?? "embeddinggemma",
  dimensions: 768,
  timeoutMs: 60_000,
  maxConcurrency: 1,
  transportRetries: 1,
});
const memories = new MemoryService(persistence, authorizer, embeddings, DEFAULT_MEMORY_LIMITS);
const identity = new IdentityService(persistence);
const resultsPath = join(root, "services/training/results/m6-evaluation.json");
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), demonstration: "not_completed" };

try {
  const admin = await identity.getActor("00000000-0000-4000-8000-000000000001");
  const evaluator = await identity.getActor("00000000-0000-4000-8000-000000000209");
  if (!admin || !evaluator) {
    throw new Error("Admin or Evaluation principal is missing. Run pnpm db:seed against 5433.");
  }
  const adminCtx = { actor: admin, correlationId: "m6-admin" };
  const evaluatorCtx = { actor: evaluator, correlationId: "m6-evaluation" };
  const qwenBefore = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  const gemmaBefore = await persistence.repos.models.findById(GEMMA3_270M_MODEL_ID);
  const m5Before = await persistence.repos.training.findEvaluation(CANDIDATE_ID);
  if (!m5Before || m5Before.runId !== M5_RUN_ID) {
    throw new Error("The historical M5 evaluation row is missing");
  }
  report.qwenBefore = { status: qwenBefore?.status, artifactUri: qwenBefore?.artifactUri };
  report.gemmaBefore = { status: gemmaBefore?.status, artifactUri: gemmaBefore?.artifactUri };
  report.historicalM5EvaluationId = m5Before.id;

  const suite = await evaluation.createSuite(evaluatorCtx, { slug: "m6-arithmetic-holdout", name: "M6 arithmetic holdout" });
  const versions = await persistence.repos.evaluation.listVersions(suite.id);
  let version = versions.find((row) => row.status === "published") ?? versions.find((row) => row.status === "draft");
  if (!version) {
    const created = await evaluation.addVersion(evaluatorCtx, suite.id, {
      description: "Five held-out sums from the M5 Gemma experiment",
      domain: "arithmetic",
      source: "m5-holdout",
      license: "internal",
      protocol: "greedy decoding, 8 tokens, equation-aware scorer m6-equation-v1",
      sealed: true,
      items: HOLDOUT,
    });
    version = await persistence.repos.evaluation.findVersion(created.id);
  }
  if (!version) {
    throw new Error("benchmark version was not stored");
  }
  if (version.status === "draft") {
    await evaluation.publishVersion(adminCtx, version.id);
  }
  report.benchmark = { suiteId: suite.id, versionId: version.id, scorer: "arithmetic/m6-equation-v1", sealed: true };

  const historical = await evaluation.run(adminCtx, { versionId: version.id, candidateId: CANDIDATE_ID, source: "historical", ...HISTORICAL });
  const historicalGate = await evaluation.decide(adminCtx, historical.runId);
  const live = await evaluation.run(adminCtx, { versionId: version.id, candidateId: CANDIDATE_ID, source: "live" });
  const liveReport = await evaluation.getReport(adminCtx, live.runId);
  const liveGate = await evaluation.decide(adminCtx, live.runId);
  report.historical = { summary: historical.summary, gate: historicalGate.decision, rationale: historicalGate.rationale };
  report.live = { summary: live.summary, gate: liveGate.decision, rationale: liveGate.rationale, items: liveReport.items };
  if (liveGate.decision === "PASS" || historicalGate.decision === "PASS") {
    throw new Error("The five-item gate returned PASS");
  }

  report.forgetting = await forgetDisposable(evaluatorCtx, adminCtx);
  report.rollback = await rollBack(evaluatorCtx, adminCtx);

  const qwenAfter = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  const gemmaAfter = await persistence.repos.models.findById(GEMMA3_270M_MODEL_ID);
  const m5After = await persistence.repos.training.findEvaluation(CANDIDATE_ID);
  report.qwenAfter = { status: qwenAfter?.status, artifactUri: qwenAfter?.artifactUri };
  report.gemmaAfter = { status: gemmaAfter?.status, artifactUri: gemmaAfter?.artifactUri };
  report.productionUnchanged = qwenBefore?.status === qwenAfter?.status && qwenBefore?.artifactUri === qwenAfter?.artifactUri && qwenAfter?.status === "not_deployed" && qwenAfter.artifactUri === null;
  report.historicalM5Unchanged = JSON.stringify(m5Before) === JSON.stringify(m5After);
  report.finishedAt = new Date().toISOString();
  if (!report.productionUnchanged || !report.historicalM5Unchanged) {
    throw new Error("Production routing or the M5 evaluation row changed");
  }
  const forgetting = report.forgetting as { retrievableAfter: boolean; embeddingRemoved: boolean; auditKept: boolean; secretInAudit: boolean };
  const rollback = report.rollback as { status: string };
  if (forgetting.retrievableAfter || !forgetting.embeddingRemoved || !forgetting.auditKept || forgetting.secretInAudit || rollback.status !== "completed") {
    throw new Error("Forgetting or rollback verification failed");
  }
  report.demonstration = "completed";
} catch (error) {
  report.demonstration = "blocked";
  report.error = error instanceof Error ? error.message : "unknown error";
  throw error;
} finally {
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  await close();
}

async function forgetDisposable(
  evaluatorCtx: { actor: Awaited<ReturnType<IdentityService["getActor"]>> & object; correlationId: string },
  adminCtx: { actor: Awaited<ReturnType<IdentityService["getActor"]>> & object; correlationId: string },
) {
  const phrase = "m6-disposable-forgetting-token";
  const existing = await persistence.repos.evaluation.findForgettingByKey("m6-disposable-forgetting-v1");
  const productionBefore = await persistence.repos.memories.findById(PRODUCTION_MEMORY_ID);
  if (existing?.status === "completed") {
    const othersBefore = await digestExcept(existing.memoryId);
    const search = await memories.searchMemories(evaluatorCtx, { query: phrase, topK: 5, recordUsage: false });
    return {
      requestId: existing.id,
      memoryId: existing.memoryId,
      alreadyCompleted: true,
      retrievableAfter: search.hits.some((hit) => hit.id === existing.memoryId),
      embeddingRemoved: (await embeddingCount(existing.memoryId)) === 0,
      auditKept: await auditHasTombstone(existing.memoryId, phrase),
      secretInAudit: await auditContains(existing.memoryId, phrase),
      otherMemoriesUnchanged: (await digestExcept(existing.memoryId)) === othersBefore,
      productionMemoryUnchanged: (await persistence.repos.memories.findById(PRODUCTION_MEMORY_ID))?.contentHash === productionBefore?.contentHash,
    };
  }
  const created = await memories.createMemory(evaluatorCtx, {
    scope: "agent",
    category: "semantic",
    title: "m6 disposable",
    summary: "temporary forgetting fixture",
    content: phrase,
    provenance: "user_provided",
    idempotencyKey: "m6-disposable-memory-v1",
  });
  let embedded = created;
  if (embedded.embeddingModel !== "embeddinggemma") {
    const vector = await embeddings.embedText(`${embedded.title}\n${embedded.summary}\n${phrase}`);
    if (vector.model !== "embeddinggemma" || vector.values.length !== 768) {
      throw new Error(`embeddinggemma did not return a 768-d vector (${vector.model}, ${vector.values.length})`);
    }
    await persistence.repos.memories.saveEmbedding({ memoryId: embedded.id, model: vector.model, dimensions: vector.dimensions, values: vector.values });
    const fresh = await persistence.repos.memories.findById(embedded.id);
    if (!fresh || fresh.embeddingModel !== "embeddinggemma") {
      throw new Error("the disposable embedding was not stored");
    }
    embedded = { ...embedded, embeddingModel: fresh.embeddingModel, embeddingDimensions: fresh.embeddingDimensions };
  }
  const before = await memories.searchMemories(evaluatorCtx, { query: phrase, topK: 5, recordUsage: false });
  if (!before.hits.some((hit) => hit.id === embedded.id)) {
    throw new Error("disposable memory was not retrievable before forgetting");
  }
  const othersAtRequest = await digestExcept(created.id);
  const requested = await evaluation.requestForgetting(evaluatorCtx, embedded.id, "m6-disposable-forgetting-v1");
  if (JSON.stringify(requested.impact).includes(phrase)) {
    throw new Error("forgetting impact included memory plaintext");
  }
  await evaluation.approveForgetting(adminCtx, requested.id);
  const executed = await evaluation.executeForgetting(adminCtx, requested.id);
  const after = await memories.searchMemories(evaluatorCtx, { query: phrase, topK: 5, recordUsage: false });
  let hidden = false;
  try {
    await memories.getMemory(adminCtx, embedded.id);
  } catch {
    hidden = true;
  }
  return {
    requestId: executed.id,
    memoryId: embedded.id,
    relation: (requested.impact as { relation?: string }).relation ?? null,
    weightUnlearning: false,
    retrievableBefore: true,
    retrievableAfter: after.hits.some((hit) => hit.id === embedded.id) || !hidden,
    embeddingRemoved: (await embeddingCount(embedded.id)) === 0,
    auditKept: await auditHasTombstone(embedded.id, phrase),
    secretInAudit: await auditContains(embedded.id, phrase),
    otherMemoriesUnchanged: (await digestExcept(embedded.id)) === othersAtRequest,
    productionMemoryUnchanged: (await persistence.repos.memories.findById(PRODUCTION_MEMORY_ID))?.contentHash === productionBefore?.contentHash,
  };
}

async function rollBack(
  evaluatorCtx: { actor: Awaited<ReturnType<IdentityService["getActor"]>> & object; correlationId: string },
  adminCtx: { actor: Awaited<ReturnType<IdentityService["getActor"]>> & object; correlationId: string },
) {
  const candidate = await persistence.repos.training.findCandidate(CANDIDATE_ID);
  if (!candidate || candidate.status === "revoked" || candidate.status === "quarantined") {
    return { status: "skipped", reason: candidate?.status ?? "missing" };
  }
  const trainableId = (await persistence.repos.training.findAdapter(candidate.adapterId))?.baseTrainableModelId;
  if (!trainableId) {
    throw new Error("M5 adapter base checkpoint is missing");
  }
  const first = await evaluation.changeRoute(adminCtx, { slug: "m6-experimental", kind: "candidate", candidateId: CANDIDATE_ID });
  const second = await evaluation.changeRoute(adminCtx, { slug: "m6-experimental", kind: "baseline", trainableModelId: trainableId });
  const requested = await evaluation.requestRollback(evaluatorCtx, first.routeId, 1, "Restore the evaluated Gemma adapter route");
  await evaluation.approveRollback(adminCtx, requested.id);
  const executed = await evaluation.executeRollback(adminCtx, requested.id);
  const revoked = await evaluation.revoke(adminCtx, CANDIDATE_ID, "Five-item arithmetic evidence is not an improvement");
  const routes = await evaluation.listRoutes(adminCtx);
  const route = routes.data.find((row) => row.id === first.routeId);
  return {
    status: executed.status,
    fromVersion: second.version,
    restoredVersion: 1,
    adapterSha256: executed.verification.adapterSha256,
    loadedAdapter: executed.verification.loadedAdapter,
    verificationOutput: executed.verification.output,
    revokedStatus: revoked.status,
    routeAfterRevoke: route?.currentVersion ?? null,
  };
}

async function embeddingCount(memoryId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from memory_embeddings where memory_id = ${memoryId}`);
  return Number(rows[0]?.n ?? 0);
}

async function digestExcept(memoryId: string): Promise<string> {
  const rows = await db.execute<{ digest: string }>(sql`
    select coalesce(md5(string_agg(id::text || ':' || content_hash, ',' order by id::text)), '') as digest
    from memories
    where id <> ${memoryId}
  `);
  return String(rows[0]?.digest ?? "");
}

async function auditContains(memoryId: string, phrase: string): Promise<boolean> {
  const rows = await db.execute<{ blob: string }>(sql`
    select coalesce(string_agg(event_type || coalesce(after_state::text, '') || coalesce(metadata::text, ''), ' '), '') as blob
    from audit_events
    where target_id = ${memoryId}
  `);
  return String(rows[0]?.blob ?? "").includes(phrase);
}

async function auditHasTombstone(memoryId: string, phrase: string): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_events
    where target_id = ${memoryId} and event_type = 'memory.forgotten'
  `);
  return Number(rows[0]?.n ?? 0) > 0 && !(await auditContains(memoryId, phrase));
}
