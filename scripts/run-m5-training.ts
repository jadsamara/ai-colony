import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "../packages/contracts/dist/index.js";
import { Authorizer, DEFAULT_MESSAGING_POLICY, IdentityService, MessagingService, MlxTrainingProvider, TrainingService } from "../packages/core/dist/index.js";
import { createDatabase, createPersistence } from "../packages/database/dist/index.js";

const root = join(import.meta.dirname, "..");
const checkpoint = join(root, "services/training/checkpoints/gemma-3-270m-it-bf16/model.safetensors");
const python = join(root, "services/training/.venv/bin/python");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("127.0.0.1:5433")) {
  throw new Error("DATABASE_URL must be the canonical Homebrew database on 127.0.0.1:5433");
}

const { db, close } = createDatabase(databaseUrl);
const persistence = createPersistence(db, close);
const authorizer = new Authorizer();
const training = new TrainingService(
  persistence,
  authorizer,
  new MlxTrainingProvider({ pythonPath: python, scriptsDir: join(root, "services/training") }),
  new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY),
  {
    artifacts: join(root, "services/training/artifacts"),
    checkpoints: join(root, "services/training/checkpoints"),
  },
);
const identity = new IdentityService(persistence);
const resultsPath = join(root, "services/training/results/m5-gemma3-270m.json");
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), checkpoint, demonstration: "not_completed" };

try {
  const admin = await identity.getActor("00000000-0000-4000-8000-000000000001");
  const proposer = await identity.getActor("00000000-0000-4000-8000-000000000208");
  if (!admin || !proposer) {
    throw new Error("Admin or Weight Optimization principal is missing. Run pnpm db:seed against 5433.");
  }
  const adminCtx = { actor: admin, correlationId: "m5-admin" };
  const proposerCtx = { actor: proposer, correlationId: "m5-weight" };
  const qwenBefore = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  report.qwenBefore = { status: qwenBefore?.status, artifactUri: qwenBefore?.artifactUri };
  const sha256 = createHash("sha256").update(readFileSync(checkpoint)).digest("hex");
  const registered = await training.registerCheckpoint(adminCtx, {
    registryModelId: GEMMA3_270M_MODEL_ID,
    checkpointPath: checkpoint,
    expectedSha256: sha256,
    source: "mlx-community/gemma-3-270m-it-bf16",
    revision: "bf16",
    tokenizerId: "gemma-3-270m-it",
    precision: "bf16",
    architecture: "gemma3_text",
    framework: "mlx-lm",
    frameworkVersion: "0.32.2",
    license: "gemma",
    contextLength: 32768,
  });
  report.checkpointSha256 = sha256;
  report.trainableModelId = registered.id;
  const dataset = await training.createDataset(proposerCtx, {
    name: "gemma3-270m-arithmetic",
    taskDomain: "structured-arithmetic",
    source: "curated_arithmetic",
    exampleCount: 48,
    seed: 7,
    idempotencyKey: "m5-curated-arithmetic-v1",
  });
  report.dataset = {
    versionId: dataset.versionId,
    contentHash: dataset.contentHash,
    trainCount: dataset.trainCount,
    validationCount: dataset.validationCount,
    testCount: dataset.testCount,
    criteria: dataset.criteria,
  };
  let run = await training.proposeRun(proposerCtx, {
    trainableModelId: registered.id,
    datasetVersionId: dataset.versionId,
    profile: "gemma3-270m-math-v1",
    seed: 7,
    idempotencyKey: "m5-gemma3-270m-math-v1",
  });
  report.runId = run.id;
  if (run.status === "awaiting_approval") {
    run = await training.approve(adminCtx, run.id);
  }
  if (run.status === "queued") {
    run = await training.execute(adminCtx, run.id);
  }
  report.executeStatus = run.status;
  if (run.status !== "evaluating" && run.status !== "completed") {
    throw new Error(`training stopped in ${run.status}${run.error ? `: ${run.error}` : ""}`);
  }
  const evaluation = await training.evaluate(adminCtx, run.id);
  report.evaluation = evaluation;
  const artifacts = await training.artifacts(adminCtx, run.id);
  report.artifacts = artifacts.data;
  report.metrics = (await training.metrics(adminCtx, run.id)).data;
  const candidate = (await training.listCandidates(adminCtx)).data.find((row) => row.runId === run.id);
  if (!candidate) {
    throw new Error("trained candidate row is missing");
  }
  if (evaluation.acceptanceMet) {
    report.promotion = await training.promote(adminCtx, candidate.id, "Held-out numeric accuracy improved under the sealed criteria.");
    report.experimentalInference = await training.experimentalInfer(adminCtx, candidate.id, "6 + 1");
  } else {
    report.promotion = "rejected: held-out numeric accuracy did not strictly improve";
    report.experimentalInference = "withheld: the candidate is not approved";
  }
  const qwenAfter = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  report.qwenAfter = { status: qwenAfter?.status, artifactUri: qwenAfter?.artifactUri };
  report.productionUnchanged = qwenBefore?.status === qwenAfter?.status && qwenBefore?.artifactUri === qwenAfter?.artifactUri;
  const reopened = createDatabase(databaseUrl);
  const again = createPersistence(reopened.db, reopened.close);
  const persisted = await again.repos.training.findTrainable(registered.id);
  const persistedArtifacts = await again.repos.training.listArtifacts(run.id);
  report.restart = {
    trainableSha256: persisted?.sha256,
    artifactSha256: persistedArtifacts[0]?.sha256,
    matches: persisted?.sha256 === sha256,
  };
  await reopened.close();
  report.demonstration = evaluation.acceptanceMet ? "completed_accepted" : "completed_rejected";
} catch (error) {
  report.demonstration = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  mkdirSync(join(root, "services/training/results"), { recursive: true });
  report.finishedAt = new Date().toISOString();
  writeFileSync(resultsPath, JSON.stringify(report, null, 2));
  await close().catch(() => undefined);
}
