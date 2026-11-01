import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "../packages/contracts/dist/index.js";
import {
  Authorizer,
  DEFAULT_MEMORY_LIMITS,
  DEFAULT_MESSAGING_POLICY,
  DepartmentLearningService,
  EvaluationService,
  IdentityService,
  MemoryService,
  MessagingService,
  MlxTrainingProvider,
  TrainingService,
} from "../packages/core/dist/index.js";
import { createDatabase, createPersistence } from "../packages/database/dist/index.js";
import { OllamaEmbeddingProvider } from "../packages/inference/dist/index.js";

const root = join(import.meta.dirname, "..");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("127.0.0.1:5433")) {
  throw new Error("DATABASE_URL must be the canonical Homebrew database on 127.0.0.1:5433");
}

const MATH = "00000000-0000-4000-8000-000000000204";
const MATH_DEPT = "00000000-0000-4000-8000-000000000019";
const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPT = "00000000-0000-4000-8000-00000000001b";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const WEIGHT = "00000000-0000-4000-8000-000000000208";
const EVAL = "00000000-0000-4000-8000-000000000209";
const ADMIN = "00000000-0000-4000-8000-000000000001";
const REVOKED = "4c67ce90-ad8c-4b9b-9994-2a9454e915d7";
const checkpoint = join(root, "services/training/checkpoints/gemma-3-270m-it-bf16/model.safetensors");
const resultsPath = join(root, "services/training/results/m7-learning.json");

const { db, close } = createDatabase(databaseUrl);
const persistence = createPersistence(db, close);
const authorizer = new Authorizer();
const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY);
const roots = { artifacts: join(root, "services/training/artifacts"), checkpoints: join(root, "services/training/checkpoints") };
const provider = new MlxTrainingProvider({ pythonPath: join(root, "services/training/.venv/bin/python"), scriptsDir: join(root, "services/training") });
const training = new TrainingService(persistence, authorizer, provider, messages, roots);
const evaluation = new EvaluationService(persistence, authorizer, provider, messages, roots);
const memories = new MemoryService(
  persistence,
  authorizer,
  new OllamaEmbeddingProvider({ baseUrl: "http://127.0.0.1:11434", model: "embeddinggemma", dimensions: 768, timeoutMs: 60_000, maxConcurrency: 1, transportRetries: 1 }),
  DEFAULT_MEMORY_LIMITS,
);
const learning = new DepartmentLearningService(persistence, authorizer, messages, training, evaluation, memories);
const identity = new IdentityService(persistence);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), demonstration: "not_completed" };

try {
  const actors = {
    admin: await must(ADMIN),
    math: await must(MATH),
    science: await must(SCIENCE),
    research: await must(RESEARCH),
    weight: await must(WEIGHT),
    evaluation: await must(EVAL),
  };
  const admin = ctx(actors.admin, "m7-admin");
  const math = ctx(actors.math, "m7-math");
  const science = ctx(actors.science, "m7-science");
  const research = ctx(actors.research, "m7-research");
  const weight = ctx(actors.weight, "m7-weight");
  const evaluator = ctx(actors.evaluation, "m7-evaluation");
  const qwenBefore = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  const m5Before = await persistence.repos.training.findEvaluation(REVOKED);
  const revokedBefore = await persistence.repos.training.findCandidate(REVOKED);
  report.qwenBefore = { status: qwenBefore?.status, artifactUri: qwenBefore?.artifactUri };
  report.revokedCandidateBefore = revokedBefore?.status;

  report.knowledge = await knowledge(research, science);
  report.specialization = await specialization(admin, math, science);
  report.training = await weightCycle(admin, math, weight, evaluator);
  report.recovery = await recover(admin, String((report.training as { cycleId: string }).cycleId));

  const qwenAfter = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  const m5After = await persistence.repos.training.findEvaluation(REVOKED);
  const revokedAfter = await persistence.repos.training.findCandidate(REVOKED);
  report.qwenAfter = { status: qwenAfter?.status, artifactUri: qwenAfter?.artifactUri };
  report.productionUnchanged = qwenBefore?.status === qwenAfter?.status && qwenBefore?.artifactUri === qwenAfter?.artifactUri && qwenAfter?.status === "not_deployed" && qwenAfter.artifactUri === null;
  report.historicalM5Unchanged = JSON.stringify(m5Before) === JSON.stringify(m5After);
  report.revokedCandidateAfter = revokedAfter?.status;
  report.finishedAt = new Date().toISOString();
  const trainingReport = report.training as { gate: string; adopted: boolean };
  const recoveryReport = report.recovery as { retrained: boolean };
  const promotedWithoutPass = trainingReport.adopted && trainingReport.gate !== "PASS";
  if (!report.productionUnchanged || !report.historicalM5Unchanged || revokedAfter?.status !== "revoked" || promotedWithoutPass || recoveryReport.retrained) {
    throw new Error("M7 demonstration violated a safety check");
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

async function knowledge(research: ReturnType<typeof ctx>, science: ReturnType<typeof ctx>) {
  const created = await memories.createMemory(research, {
    scope: "agent",
    category: "semantic",
    title: "boiling point",
    summary: "Verified reference fact",
    content: "M7-VERIFIED-FACT At 1 atmosphere, water boils at 100 C.",
    provenance: "user_provided",
    idempotencyKey: "m7-demo-verified-fact",
  });
  const transfer = await learning.transferKnowledge(research, { destinationDepartmentId: SCIENCE_DEPT, sourceMemoryId: created.id, idempotencyKey: "m7-demo-transfer" });
  const accepted = await learning.validateTransfer(science, transfer.id, "accept", "The source provenance is user_provided");
  const search = await memories.searchMemories(science, { query: "M7-VERIFIED-FACT", scopes: ["department"], topK: 5, recordUsage: false });
  let rejected = "rejected";
  try {
    const generated = await memories.createMemory(research, {
      scope: "agent",
      category: "semantic",
      title: "guess",
      summary: "unverified model text",
      content: "M7-UNVERIFIED model guess",
      provenance: "model_generated",
      idempotencyKey: "m7-demo-unverified",
    });
    await learning.transferKnowledge(research, { destinationDepartmentId: SCIENCE_DEPT, sourceMemoryId: generated.id, idempotencyKey: "m7-demo-bad-transfer" });
    rejected = "accepted";
  } catch (error) {
    rejected = error instanceof Error ? error.message : "rejected";
  }
  return {
    transferId: transfer.id,
    sourceMemoryId: created.id,
    acceptedMemoryId: accepted.acceptedMemoryId,
    retrieved: search.hits.some((hit) => hit.id === accepted.acceptedMemoryId),
    retrievalMode: search.mode,
    embeddingModel: created.embeddingModel,
    invalidTransfer: rejected,
    outcome: "MEMORY_IMPROVEMENT",
  };
}

async function specialization(admin: ReturnType<typeof ctx>, math: ReturnType<typeof ctx>, science: ReturnType<typeof ctx>) {
  const registered = await learning.registerCapability(math, { departmentId: MATH_DEPT, slug: "exact-addition", domain: "arithmetic", taskType: "addition", description: "Integer addition through an approved tool", tools: ["exact_arithmetic"] });
  await learning.approveCapability(admin, registered.version.id, registered.capability.id);
  const mathResult = await learning.executeTool(math, MATH_DEPT, "exact_arithmetic", "8 + 5");
  let scienceDenied = "";
  try {
    await learning.executeTool(science, SCIENCE_DEPT, "exact_arithmetic", "8 + 5");
    scienceDenied = "allowed";
  } catch (error) {
    scienceDenied = error instanceof Error ? error.message : "denied";
  }
  const mathAssignment = await learning.assignModel(admin, { departmentId: MATH_DEPT, role: "shared_base", registryModelId: QWEN3_8B_MODEL_ID });
  const scienceAssignment = await learning.assignModel(admin, { departmentId: SCIENCE_DEPT, role: "shared_base", registryModelId: QWEN3_8B_MODEL_ID });
  let incompatible = "";
  try {
    await learning.assignModel(admin, { departmentId: MATH_DEPT, role: "experimental_adapter", registryModelId: QWEN3_8B_MODEL_ID, candidateId: REVOKED });
    incompatible = "assigned";
  } catch (error) {
    incompatible = error instanceof Error ? error.message : "rejected";
  }
  return {
    mathDepartment: MATH_DEPT,
    scienceDepartment: SCIENCE_DEPT,
    mathTool: mathResult,
    scienceTool: scienceDenied,
    mathAssignment: { family: mathAssignment.modelFamily, candidateId: mathAssignment.candidateId, role: mathAssignment.role },
    scienceAssignment: { family: scienceAssignment.modelFamily, candidateId: scienceAssignment.candidateId, role: scienceAssignment.role },
    revokedAdapterOnQwen: incompatible,
    independentlyTrained: false,
  };
}

async function weightCycle(admin: ReturnType<typeof ctx>, math: ReturnType<typeof ctx>, weight: ReturnType<typeof ctx>, evaluator: ReturnType<typeof ctx>) {
  const sha256 = createHash("sha256").update(readFileSync(checkpoint)).digest("hex");
  const trainable = await training.registerCheckpoint(admin, {
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
  const suite = await evaluation.createSuite(evaluator, { slug: "m7-addition-holdout", name: "M7 addition holdout" });
  const versions = await persistence.repos.evaluation.listVersions(suite.id);
  let version = versions.find((row) => row.status === "published") ?? versions.find((row) => row.status === "draft");
  if (!version) {
    const created = await evaluation.addVersion(evaluator, suite.id, {
      description: "Thirty addition items disjoint from the curated 0-16 training range",
      domain: "arithmetic",
      source: "m7-local",
      license: "internal",
      protocol: "greedy 8 tokens, scorer m6-equation-v1",
      sealed: true,
      items: Array.from({ length: 30 }, (_, index) => ({ prompt: `40 + ${index + 1}`, expected: String(40 + index + 1) })),
    });
    version = await persistence.repos.evaluation.findVersion(created.id);
  }
  if (!version) {
    throw new Error("benchmark version missing");
  }
  if (version.status === "draft") {
    await evaluation.publishVersion(admin, version.id);
  }
  const hidden = await evaluation.getVersion(math, version.id);
  const gap = await learning.observeGap(math, {
    departmentId: MATH_DEPT,
    taskCategory: "m7-addition-holdout",
    evidenceKind: "evaluation",
    evidenceRefs: [version.id],
    failureCount: 2,
    severity: "high",
    impact: "The prior five-item Gemma adapter was worse than its baseline",
    proposedMethod: "lora",
    baseline: { source: "m6-gate", candidate: REVOKED, decision: "FAIL" },
  });
  await learning.validateGap(math, gap.gap.id);
  const objective = await learning.createObjective(math, gap.gap.id, { weakness: "Held-out addition outside the earlier five-item set", benchmarkVersionId: version.id });
  let blocked = "";
  try {
    await learning.executeTraining(admin, objective.cycleId);
    blocked = "executed";
  } catch (error) {
    blocked = error instanceof Error ? error.message : "blocked";
  }
  const proposed = await learning.proposeTraining(weight, objective.cycleId, { name: "m7-addition", taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 11, idempotencyKey: "m7-demo-dataset" }, trainable.id);
  await learning.approveTraining(admin, objective.cycleId);
  const executed = await learning.executeTraining(admin, objective.cycleId);
  const scored = await learning.evaluateCycle(evaluator, objective.cycleId);
  const gate = await learning.applyGate(admin, objective.cycleId);
  let adopted = false;
  try {
    adopted = (await learning.adopt(admin, objective.cycleId)).adopted;
  } catch {
    adopted = false;
  }
  const published = await learning.publishResult(evaluator, objective.cycleId);
  const summary = "summary" in scored ? scored.summary : null;
  return {
    cycleId: objective.cycleId,
    objectiveId: objective.objective.id,
    benchmarkVersionId: version.id,
    sealedItemsHiddenFromMath: hidden.items.length === 0,
    executionBeforeApproval: blocked,
    trainingRunId: proposed.run?.id ?? null,
    trainingStatus: executed.run.status,
    retrained: executed.retrained,
    evaluationRunId: scored.evaluationRunId,
    summary,
    gate: gate.decision,
    adopted,
    published,
    retrainedTwice: false,
  };
}

async function recover(admin: ReturnType<typeof ctx>, cycleId: string) {
  const again = new DepartmentLearningService(persistence, authorizer, messages, training, evaluation, memories);
  const resumed = await again.resume(admin, cycleId);
  let retrained = false;
  try {
    retrained = (await again.executeTraining(admin, cycleId)).retrained;
  } catch {
    retrained = false;
  }
  return { next: resumed.next, executedByResume: resumed.executed, trainingStatus: resumed.trainingStatus, retrained };
}

async function must(id: string) {
  const actor = await identity.getActor(id);
  if (!actor) {
    throw new Error(`Principal ${id} is missing. Seed the canonical database.`);
  }
  return actor;
}

function ctx(actor: NonNullable<Awaited<ReturnType<IdentityService["getActor"]>>>, correlationId: string) {
  return { actor, correlationId };
}
