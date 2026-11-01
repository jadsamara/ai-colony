import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID } from "../packages/contracts/dist/index.js";
import {
  Authorizer,
  CollaborationService,
  DEFAULT_MEMORY_LIMITS,
  DEFAULT_MESSAGING_POLICY,
  DepartmentLearningService,
  DomainError,
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

const HISTORICAL = "f96ff49d-2258-4d65-800f-37263d25ec26";
const CANDIDATE = "90e946d9-1f73-416a-b48d-fb34e5492494";
const EVALUATION = "396efaba-7bf4-4949-b571-8611d9f70515";
const MATH = "00000000-0000-4000-8000-000000000204";
const MATH_DEPT = "00000000-0000-4000-8000-000000000019";
const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPT = "00000000-0000-4000-8000-00000000001b";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const WEIGHT = "00000000-0000-4000-8000-000000000208";
const EVAL = "00000000-0000-4000-8000-000000000209";
const ADMIN = "00000000-0000-4000-8000-000000000001";
const checkpoint = join(root, "services/training/checkpoints/gemma-3-270m-it-bf16/model.safetensors");
const resultsPath = join(root, "services/training/results/m7h-hardening.json");

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
const collaboration = new CollaborationService(persistence, authorizer, memories, messages);
const identity = new IdentityService(persistence);

function ctx(actor: NonNullable<Awaited<ReturnType<IdentityService["getActor"]>>>, correlationId: string) {
  return { actor, correlationId };
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), demonstration: "not_completed" };

try {
  const adminActor = await identity.getActor(ADMIN);
  const mathActor = await identity.getActor(MATH);
  const scienceActor = await identity.getActor(SCIENCE);
  const researchActor = await identity.getActor(RESEARCH);
  const weightActor = await identity.getActor(WEIGHT);
  const evaluationActor = await identity.getActor(EVAL);
  if (!adminActor || !mathActor || !scienceActor || !researchActor || !weightActor || !evaluationActor) {
    throw new Error("A required principal is missing");
  }
  const admin = ctx(adminActor, "m7h-admin");
  const math = ctx(mathActor, "m7h-math");
  const science = ctx(scienceActor, "m7h-science");
  const research = ctx(researchActor, "m7h-research");
  const weight = ctx(weightActor, "m7h-weight");
  const evaluator = ctx(evaluationActor, "m7h-evaluation");
  const qwenBefore = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  const before = await learning.getCycle(admin, HISTORICAL);
  const decision = await learning.verifyImprovement(evaluator, HISTORICAL);
  const after = await learning.getCycle(admin, HISTORICAL);
  const candidate = await persistence.repos.training.findCandidateByRun(before.cycle.trainingRunId ?? "");
  report.evaluation = {
    cycleId: HISTORICAL,
    evaluationRunId: EVALUATION,
    safetyGate: decision.safetyGate,
    safetyGateVersion: decision.safetyGateVersion,
    classification: decision.classification,
    deploymentEligibility: decision.deploymentEligibility,
    effectSize: decision.effectSize,
    sampleCount: decision.sampleCount,
    historicalStatus: after.cycle.status,
    historicalGate: after.cycle.gateDecision,
    historicalOutcome: after.outcome?.kind ?? null,
    preserved: before.cycle.status === after.cycle.status && before.cycle.gateDecision === after.cycle.gateDecision && before.outcome?.kind === after.outcome?.kind,
    candidateId: candidate?.id ?? null,
    candidateStatus: candidate?.status ?? null,
  };
  const stamp = Date.now().toString();
  const consultation = await collaboration.openConsultation(math, {
    recipientDepartmentId: SCIENCE_DEPT,
    question: `MATH-PRIVATE-${stamp} needs the gravitational constant`,
    idempotencyKey: `m7h-consult-${stamp}`,
    ttlMs: 60_000,
  });
  const visible = await collaboration.read(science, consultation.contextId!);
  const outsider = await rejected(() => collaboration.read(research, consultation.contextId!));
  const answer = await collaboration.contribute(science, consultation.contextId!, {
    content: "G=6.67430e-11",
    kind: "answer",
    provenance: "user_provided",
    idempotencyKey: `m7h-answer-${stamp}`,
    relevantToRecipientDomain: true,
  });
  const retained = await collaboration.retainAnswer(math, answer.id);
  const scienceHits = await memories.searchMemories(science, { query: `MATH-PRIVATE-${stamp}`, statuses: ["candidate", "validated"] });
  await collaboration.close(math, consultation.contextId!);
  const closed = await collaboration.read(science, consultation.contextId!);
  report.consultation = {
    contextId: consultation.contextId,
    scienceSawRequest: visible.entries.some((entry) => entry.content.includes(`MATH-PRIVATE-${stamp}`)),
    researchDenied: outsider,
    retainedMemoryId: retained.memoryId,
    retainedProvenance: retained.provenance,
    scienceSearchHits: scienceHits.hits.length,
    scienceSawPrivateObjective: scienceHits.hits.some((hit) => `${hit.title}\n${hit.summary}\n${hit.content}`.includes(`MATH-PRIVATE-${stamp}`)),
    closedContentEmpty: closed.entries.every((entry) => entry.content === ""),
  };
  const joint = await collaboration.openJoint(math, { recipientDepartmentId: SCIENCE_DEPT, purpose: "shared orbital calculation", idempotencyKey: `m7h-joint-${stamp}` });
  const early = await rejected(() => collaboration.contribute(math, joint.contextId!, { content: "too soon", kind: "shared_decision", provenance: "user_provided", idempotencyKey: `m7h-joint-early-${stamp}`, relevantToRecipientDomain: true }));
  await collaboration.accept(science, joint.contextId!);
  const shared = await collaboration.contribute(math, joint.contextId!, { content: `JOINT-MU-${stamp}`, kind: "shared_decision", provenance: "user_provided", idempotencyKey: `m7h-joint-mu-${stamp}`, relevantToRecipientDomain: true });
  const scienceJoint = await collaboration.read(science, joint.contextId!);
  const researchJoint = await rejected(() => collaboration.read(research, joint.contextId!));
  const promoted = await collaboration.promote(science, shared.id, true);
  await collaboration.close(math, joint.contextId!);
  const afterClose = await collaboration.read(science, joint.contextId!);
  report.joint = {
    contextId: joint.contextId,
    earlyRejected: early,
    scienceSawShared: scienceJoint.entries.some((entry) => entry.content.includes(`JOINT-MU-${stamp}`)),
    researchDenied: researchJoint,
    promotedMemoryId: promoted.memoryId,
    closed: afterClose.status,
    closedContentEmpty: afterClose.entries.every((entry) => entry.content === ""),
  };
  report.recovery = await recovery(admin, math, weight, evaluator, stamp);
  const qwenAfter = await persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
  report.productionUnchanged = qwenBefore?.status === qwenAfter?.status && qwenBefore?.artifactUri === qwenAfter?.artifactUri;
  const evaluationReport = report.evaluation as { preserved: boolean; classification: string; safetyGate: string; candidateId: string; candidateStatus: string };
  const consultationReport = report.consultation as { scienceSawRequest: boolean; researchDenied: boolean; scienceSawPrivateObjective: boolean; closedContentEmpty: boolean };
  const jointReport = report.joint as { earlyRejected: boolean; scienceSawShared: boolean; researchDenied: boolean; closedContentEmpty: boolean };
  const recoveryReport = report.recovery as { retrained: boolean; mlExecuted: boolean; executionBlocked: string; candidateCreated: boolean; finalStatus: string };
  if (!evaluationReport.preserved || evaluationReport.classification !== "NO_VERIFIED_IMPROVEMENT" || evaluationReport.safetyGate !== "PASS" || evaluationReport.candidateId !== CANDIDATE || evaluationReport.candidateStatus !== "experimental") {
    throw new Error("Historical M7 evaluation was not preserved");
  }
  if (!consultationReport.scienceSawRequest || !consultationReport.researchDenied || consultationReport.scienceSawPrivateObjective || !consultationReport.closedContentEmpty) {
    throw new Error("Consultation memory boundary failed");
  }
  if (!jointReport.earlyRejected || !jointReport.scienceSawShared || !jointReport.researchDenied || !jointReport.closedContentEmpty) {
    throw new Error("Joint task boundary failed");
  }
  if (recoveryReport.retrained || recoveryReport.mlExecuted || recoveryReport.executionBlocked === "executed" || recoveryReport.candidateCreated || recoveryReport.finalStatus !== "CANCELLED") {
    throw new Error("Recovery demonstration started training");
  }
  if (!report.productionUnchanged) {
    throw new Error("Production Qwen changed");
  }
  report.demonstration = "completed";
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(resultsPath, JSON.stringify(report, null, 2));
  await close();
}

async function recovery(admin: ReturnType<typeof ctx>, math: ReturnType<typeof ctx>, weight: ReturnType<typeof ctx>, evaluator: ReturnType<typeof ctx>, stamp: string) {
  const sha256 = createHash("sha256").update(readFileSync(checkpoint)).digest("hex");
  const trainable = await persistence.repos.training.findTrainableBySha(GEMMA3_270M_MODEL_ID, sha256);
  if (!trainable) {
    throw new Error("The existing Gemma checkpoint registration is missing");
  }
  const suite = await evaluation.createSuite(evaluator, { slug: `m7h-recovery-${stamp}`, name: "M7 hardening recovery" });
  const created = await evaluation.addVersion(evaluator, suite.id, {
    description: "Five-item diagnostic used only to identify a gap. It is not a promotion benchmark.",
    domain: "arithmetic",
    source: "m7h-local",
    license: "internal",
    protocol: "not evaluated",
    sealed: true,
    items: [1, 2, 3, 4, 5].map((n) => ({ prompt: `70 + ${n}`, expected: String(70 + n) })),
  });
  await evaluation.publishVersion(admin, created.id);
  const gap = await learning.observeGap(math, {
    departmentId: MATH_DEPT,
    taskCategory: `m7h-recovery-${stamp}`,
    evidenceKind: "evaluation",
    evidenceRefs: [created.id],
    failureCount: 2,
    severity: "low",
    impact: "recovery fixture",
    proposedMethod: "lora",
  });
  await learning.validateGap(math, gap.gap.id);
  const objective = await learning.createObjective(math, gap.gap.id, { weakness: "recovery fixture", benchmarkVersionId: created.id });
  const proposed = await learning.proposeTraining(weight, objective.cycleId, { name: `m7h-${stamp}`, taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 13, idempotencyKey: `m7h-data-${stamp}` }, trainable.id);
  const pending = await learning.resume(admin, objective.cycleId);
  const repeated = await learning.proposeTraining(weight, objective.cycleId, { name: `m7h-${stamp}`, taskDomain: "structured-arithmetic", source: "curated_arithmetic", exampleCount: 48, seed: 13, idempotencyKey: `m7h-data-${stamp}` }, trainable.id);
  await learning.approveTraining(admin, objective.cycleId);
  const duplicateApproval = await rejected(() => learning.approveTraining(admin, objective.cycleId));
  await learning.constrainBudget(admin, objective.cycleId, { maxRuntimeMs: 0 });
  let blocked = "";
  try {
    await learning.executeTraining(admin, objective.cycleId);
    blocked = "executed";
  } catch (error) {
    blocked = error instanceof Error ? error.message : "blocked";
  }
  const run = proposed.run?.id ? await persistence.repos.training.findRun(proposed.run.id) : null;
  const candidate = proposed.run?.id ? await persistence.repos.training.findCandidateByRun(proposed.run.id) : null;
  await learning.cancel(admin, objective.cycleId, "stop after the runtime budget refusal");
  const final = await learning.getCycle(admin, objective.cycleId);
  return {
    cycleId: objective.cycleId,
    resumeBeforeApproval: pending.next,
    trainingRunId: proposed.run?.id ?? null,
    duplicateRun: repeated.run?.id === proposed.run?.id,
    duplicateApprovalRejected: duplicateApproval,
    executionBlocked: blocked,
    runStatus: run?.status ?? null,
    candidateCreated: candidate !== null,
    retrained: false,
    mlExecuted: false,
    finalStatus: final.cycle.status,
  };
}

async function rejected(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof DomainError;
  }
}
