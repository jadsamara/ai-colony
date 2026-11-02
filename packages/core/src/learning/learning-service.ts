import { randomUUID } from "node:crypto";
import { GEMMA3_270M_MODEL_ID, QWEN3_8B_MODEL_ID, type TrainingDatasetCreate } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { MessagingService } from "../messaging/message-service.js";
import type { Persistence } from "../ports/repositories.js";
import type { EvaluationService } from "../evaluation/evaluation-service.js";
import type { MemoryService } from "../memory/memory-service.js";
import { assertNotSelfDecision } from "../training/transitions.js";
import type { TrainingService } from "../training/training-service.js";
import { GATE_POLICY } from "../evaluation/gate.js";
import { assessDeployment, IMPROVEMENT_POLICY, improvementPolicyHash, verifyImprovement } from "../evaluation/improvement.js";
import type { LearningCycleRecord } from "./repository.js";
import {
  assertLearningTransition,
  gapFingerprint,
  OBSERVABLE_EVIDENCE,
  selectLearningMethod,
  type LearningCycleStatus,
  type LearningMechanism,
  type OutcomeKind,
} from "./transitions.js";

const REVOKED_M5_CANDIDATE_ID = "4c67ce90-ad8c-4b9b-9994-2a9454e915d7";
const TERMINAL = new Set<LearningCycleStatus>(["ADOPTED", "REJECTED", "INCONCLUSIVE", "FAILED", "CANCELLED"]);

export class DepartmentLearningService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly messages: MessagingService,
    private readonly training: TrainingService,
    private readonly evaluation: EvaluationService,
    private readonly memories: MemoryService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolveDepartment(ctx: RequestContext, departmentId: string) {
    this.authorizer.assert(ctx.actor, "learning:read");
    const department = await this.requireDepartment(departmentId);
    const assignments = await this.persistence.repos.learning.listAssignments(departmentId);
    const active = assignments.find((row) => row.status === "active") ?? null;
    const capabilities = await this.persistence.repos.learning.listCapabilities(departmentId);
    const versions = [];
    for (const capability of capabilities) {
      versions.push(...(await this.persistence.repos.learning.listCapabilityVersions(capability.id)));
    }
    return {
      department: { id: department.id, slug: department.slug, name: department.name },
      assignment: active,
      sharedModel: active?.candidateId ? false : true,
      independentlyTrained: Boolean(active?.candidateId),
      capabilities: versions.filter((row) => row.status === "approved"),
      permissions: ctx.actor.permissions,
    };
  }

  async registerCapability(ctx: RequestContext, input: { departmentId: string; slug: string; domain: string; taskType: string; description: string; tools: string[] }) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    await this.requireOwnDepartment(ctx, input.departmentId);
    const existing = await this.persistence.repos.learning.findCapabilityBySlug(input.departmentId, input.slug);
    const capability = existing ?? {
      id: randomUUID(),
      departmentId: input.departmentId,
      slug: input.slug,
      domain: input.domain,
      taskType: input.taskType,
      description: input.description,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    if (!existing) {
      await this.persistence.repos.learning.insertCapability(capability);
    }
    const versions = await this.persistence.repos.learning.listCapabilityVersions(capability.id);
    const version = {
      id: randomUUID(),
      capabilityId: capability.id,
      version: versions.length + 1,
      status: "proposed" as const,
      toolNames: input.tools,
      requiredPermissions: ["learning:read"],
      evidence: {},
      evaluationRunId: null,
      benchmarkVersionId: null,
      reliability: { source: "unverified" },
      resources: { sharedBaseModel: true },
      improvementKind: "NO_VERIFIED_IMPROVEMENT" as const,
      approvedBy: null,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.learning.insertCapabilityVersion(version);
    return { capability, version };
  }

  async approveCapability(ctx: RequestContext, versionId: string, capabilityId: string) {
    this.authorizer.assert(ctx.actor, "capability:approve");
    const versions = await this.persistence.repos.learning.listCapabilityVersions(capabilityId);
    const version = versions.find((row) => row.id === versionId);
    if (!version) {
      throw notFound("Capability version", versionId);
    }
    assertNotSelfDecision(ctx.actor, version.createdBy);
    if (version.evidence.evaluationRunId === undefined && version.toolNames.length === 0) {
      throw new DomainError("NOT_APPROVED", "A capability needs tool scope or evaluation evidence before approval", 422);
    }
    const approved = { ...version, status: "approved" as const, approvedBy: ctx.actor.principalId };
    await this.persistence.repos.learning.insertCapabilityVersion({ ...approved, id: randomUUID(), version: versions.length + 1, createdAt: this.now().toISOString() });
    return { capabilityId, status: "approved" as const };
  }

  async observeGap(ctx: RequestContext, input: { departmentId: string; taskCategory: string; evidenceKind: string; evidenceRefs: string[]; failureCount: number; severity: "low" | "medium" | "high"; impact: string; proposedMethod: LearningMechanism; baseline?: Record<string, unknown> }) {
    this.authorizer.assert(ctx.actor, "learning:observe");
    await this.requireOwnDepartment(ctx, input.departmentId);
    if (!(OBSERVABLE_EVIDENCE as readonly string[]).includes(input.evidenceKind)) {
      throw new DomainError("UNVERIFIED_SIGNAL", "A capability gap requires an evaluation, task outcome, tool failure, or human correction", 422);
    }
    if (input.evidenceRefs.length < 1 || input.failureCount < 1) {
      throw new DomainError("UNVERIFIED_SIGNAL", "A capability gap requires at least one recorded failure", 422);
    }
    const fingerprint = gapFingerprint(input.departmentId, input.taskCategory, input.evidenceKind);
    const existing = await this.persistence.repos.learning.findGapByFingerprint(input.departmentId, fingerprint);
    if (existing) {
      const failureCount = existing.failureCount + input.failureCount;
      await this.persistence.repos.learning.updateGap(existing.id, { failureCount, status: "aggregated", updatedAt: this.now().toISOString(), evidence: { kind: input.evidenceKind, refs: input.evidenceRefs } });
      const cycle = await this.persistence.repos.learning.findCycleByKey(`gap:${existing.id}`);
      return { gap: { ...existing, failureCount, status: "aggregated" as const }, cycle, aggregated: true };
    }
    const gap = {
      id: randomUUID(),
      departmentId: input.departmentId,
      capabilityId: null,
      taskCategory: input.taskCategory,
      fingerprint,
      evidence: { kind: input.evidenceKind, refs: input.evidenceRefs },
      failureCount: input.failureCount,
      severity: input.severity,
      impact: input.impact,
      baseline: input.baseline ?? {},
      proposedMethod: input.proposedMethod,
      resources: { maxTrainingSteps: 40, maxInferenceCalls: 80 },
      status: "observed" as const,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    const cycle = this.newCycle(input.departmentId, `gap:${gap.id}`, "no_action", ctx.actor.principalId);
    await this.persistence.transaction(async (repos) => {
      await repos.learning.insertGap(gap);
      await repos.learning.insertCycle(cycle);
      await repos.learning.insertBudget({ id: randomUUID(), cycleId: cycle.id, maxInferenceCalls: 80, maxTrainingSteps: 40, maxRuntimeMs: 1_200_000, usedInferenceCalls: 0, usedTrainingSteps: 0, usedRuntimeMs: 0 });
      await repos.learning.insertEvent({ id: randomUUID(), cycleId: cycle.id, fromStatus: "OBSERVED", toStatus: "OBSERVED", actorId: ctx.actor.principalId, reason: "gap observed", createdAt: this.now().toISOString() });
    });
    return { gap, cycle, aggregated: false };
  }

  async validateGap(ctx: RequestContext, gapId: string) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const gap = await this.requireGap(gapId);
    await this.requireOwnDepartment(ctx, gap.departmentId);
    const kind = String(gap.evidence.kind ?? "");
    if (!(OBSERVABLE_EVIDENCE as readonly string[]).includes(kind) || gap.failureCount < 1) {
      throw new DomainError("UNVERIFIED_SIGNAL", "The gap does not have enough observable evidence", 422);
    }
    await this.persistence.repos.learning.updateGap(gap.id, { status: "validated", updatedAt: this.now().toISOString() });
    const cycle = await this.requireCycleByKey(`gap:${gap.id}`);
    await this.transition(ctx, cycle, "GAP_VALIDATED", "observable evidence validated");
    return { gapId: gap.id, status: "validated" as const, cycleId: cycle.id };
  }

  async createObjective(ctx: RequestContext, gapId: string, input: { weakness: string; benchmarkVersionId?: string }) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const gap = await this.requireGap(gapId);
    await this.requireOwnDepartment(ctx, gap.departmentId);
    if (gap.status !== "validated" && gap.status !== "aggregated") {
      throw new DomainError("INVALID_STATE", "A learning objective requires a validated gap", 409);
    }
    const mechanism = selectLearningMethod({ failureCount: gap.failureCount, evidenceKind: String(gap.evidence.kind), proposed: gap.proposedMethod });
    const existing = (await this.persistence.repos.learning.listObjectives(gap.departmentId)).filter((row) => row.gapId === gap.id);
    const objective = {
      id: randomUUID(),
      departmentId: gap.departmentId,
      gapId: gap.id,
      capabilityId: gap.capabilityId,
      version: existing.length + 1,
      weakness: input.weakness,
      mechanism,
      criteria: { gate: "m6-gate-v1", minSampleForPass: 30 },
      benchmarkVersionId: input.benchmarkVersionId ?? null,
      baselineRef: null,
      budget: gap.resources,
      status: "open",
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.learning.insertObjective(objective);
    const cycle = await this.requireCycleByKey(`gap:${gap.id}`);
    await this.transition(ctx, { ...cycle, status: "GAP_VALIDATED" }, "OBJECTIVE_CREATED", "objective recorded");
    await this.persistence.repos.learning.updateCycle(cycle.id, { objectiveId: objective.id, method: mechanism, updatedAt: this.now().toISOString() });
    const selected = await this.requireCycle(cycle.id);
    await this.transition(ctx, selected, "METHOD_SELECTED", mechanism);
    if (mechanism === "no_action") {
      await this.finish(ctx, await this.requireCycle(cycle.id), "INCONCLUSIVE", "NO_VERIFIED_IMPROVEMENT", false, "Evidence does not justify a learning action");
    } else if (mechanism === "lora") {
      await this.transition(ctx, await this.requireCycle(cycle.id), "PROPOSAL_PENDING", "training proposal requested");
      await this.notify(ctx, {
        messageType: "TRAINING_REQUEST",
        recipientDepartmentId: await this.departmentIdBySlug("weight-optimization"),
        idempotencyKey: `learning.training.${cycle.id}`,
        payload: {
          targetModelId: GEMMA3_270M_MODEL_ID,
          learningObjective: input.weakness.slice(0, 4000),
          datasetReference: `cycle:${cycle.id}`,
          trainingConstraints: { maxParameterCount: 270_000_000, notes: "Use the allowlisted gemma3-270m-math-v1 profile. This message does not start training." },
          evaluationRequirements: ["m6-gate-v1", "sealed holdout"],
        },
      });
    }
    return { objective, cycleId: cycle.id, mechanism };
  }

  async proposeTraining(ctx: RequestContext, cycleId: string, dataset: TrainingDatasetCreate, trainableModelId: string) {
    this.authorizer.assert(ctx.actor, "training:propose");
    await this.requireDepartmentSlug(ctx, "weight-optimization");
    const cycle = await this.requireCycle(cycleId);
    if (cycle.trainingRunId) {
      const existing = await this.persistence.repos.training.findRun(cycle.trainingRunId);
      return { cycle, run: existing };
    }
    if (cycle.status !== "PROPOSAL_PENDING") {
      throw new DomainError("INVALID_STATE", "Training can be proposed only from a pending learning cycle", 409);
    }
    const created = await this.training.createDataset(ctx, dataset);
    const run = await this.training.proposeRun(ctx, { trainableModelId, datasetVersionId: created.versionId, profile: "gemma3-270m-math-v1", seed: dataset.seed, idempotencyKey: `learning-run-${cycle.id}` });
    if (run.status !== "awaiting_approval") {
      throw new DomainError("INVALID_STATE", "A department proposal must stop before training execution", 409);
    }
    await this.persistence.repos.learning.updateCycle(cycle.id, { trainingRunId: run.id, updatedAt: this.now().toISOString() });
    await this.transition(ctx, await this.requireCycle(cycle.id), "AWAITING_APPROVAL", `training run ${run.id}`);
    return { cycleId, run };
  }

  async approveTraining(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "training:approve");
    const cycle = await this.requireCycle(cycleId);
    if (!cycle.trainingRunId) {
      throw new DomainError("INVALID_STATE", "The learning cycle has no training proposal", 409);
    }
    const run = await this.training.approve(ctx, cycle.trainingRunId);
    await this.transition(ctx, cycle, "APPROVED", `approved run ${run.id}`);
    return { cycleId, run };
  }

  async executeTraining(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "training:execute");
    const cycle = await this.requireCycle(cycleId);
    if (cycle.status === "CANCELLED" || cycle.status === "REJECTED") {
      throw new DomainError("INVALID_STATE", "A cancelled learning cycle cannot train", 409);
    }
    if (!cycle.trainingRunId) {
      throw new DomainError("INVALID_STATE", "The learning cycle has no training proposal", 409);
    }
    const current = await this.persistence.repos.training.findRun(cycle.trainingRunId);
    if (!current) {
      throw notFound("Training run", cycle.trainingRunId);
    }
    if (current.status === "awaiting_approval") {
      throw new DomainError("INVALID_STATE", "Training execution is blocked until an administrator approves it", 409);
    }
    if (current.status === "failed" || current.status === "cancelled") {
      return { cycleId, run: current, retrained: false };
    }
    if (current.status === "evaluating" || current.status === "completed") {
      if (cycle.status === "APPROVED") {
        await this.transition(ctx, cycle, "EXECUTING", "recovered existing training run");
        await this.transition(ctx, await this.requireCycle(cycle.id), "EVALUATING", "recovered existing training run");
      } else if (cycle.status === "EXECUTING") {
        await this.transition(ctx, cycle, "EVALUATING", "recovered existing training run");
      }
      return { cycleId, run: current, retrained: false };
    }
    if ((await this.persistence.repos.learning.countExecutingLora(cycle.id)) > 0) {
      throw new DomainError("BUDGET_EXCEEDED", "Another LoRA learning cycle is already executing", 409);
    }
    const budget = await this.persistence.repos.learning.findBudget(cycle.id);
    if (budget && budget.usedTrainingSteps + 40 > budget.maxTrainingSteps) {
      throw new DomainError("BUDGET_EXCEEDED", "The learning cycle training step budget is exhausted", 422);
    }
    if (budget && budget.usedRuntimeMs >= budget.maxRuntimeMs) {
      throw new DomainError("BUDGET_EXCEEDED", "The learning cycle runtime budget is exhausted", 422);
    }
    await this.transition(ctx, cycle, "EXECUTING", "training started");
    const started = Date.now();
    try {
      const run = await this.training.execute(ctx, cycle.trainingRunId);
      const elapsed = Date.now() - started;
      const latest = await this.requireCycle(cycle.id);
      if (latest.status === "CANCELLED" || latest.status === "FAILED") {
        return { cycleId, run, retrained: false };
      }
      if (budget) {
        await this.persistence.repos.learning.updateBudget(cycle.id, { usedTrainingSteps: budget.usedTrainingSteps + 40, usedRuntimeMs: budget.usedRuntimeMs + elapsed });
      }
      if (run.status === "cancelled") {
        await this.transition(ctx, { ...cycle, status: "EXECUTING" }, "CANCELLED", "training cancelled");
        return { cycleId, run, retrained: false };
      }
      if (run.status === "failed") {
        await this.transition(ctx, { ...cycle, status: "EXECUTING" }, "FAILED", "training worker failed");
        return { cycleId, run, retrained: false };
      }
      await this.transition(ctx, { ...cycle, status: "EXECUTING" }, "EVALUATING", "adapter stored");
      return { cycleId, run, retrained: true };
    } catch (error) {
      const latest = await this.requireCycle(cycle.id);
      if (latest.status === "EXECUTING") {
        await this.transition(ctx, latest, "FAILED", error instanceof Error ? error.message : "training worker failed");
      }
      throw error;
    }
  }

  async evaluateCycle(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:run");
    await this.requireDepartmentSlug(ctx, "evaluation");
    const cycle = await this.requireCycle(cycleId);
    if (cycle.status !== "EVALUATING") {
      throw new DomainError("INVALID_STATE", "Evaluation waits until training has stored an adapter", 409);
    }
    if (cycle.evaluationRunId) {
      return { cycleId, evaluationRunId: cycle.evaluationRunId, repeated: true };
    }
    const objective = cycle.objectiveId ? await this.persistence.repos.learning.findObjective(cycle.objectiveId) : null;
    if (!objective?.benchmarkVersionId || !cycle.trainingRunId) {
      throw new DomainError("INVALID_STATE", "The learning cycle is missing a benchmark or a training run", 409);
    }
    const candidate = await this.persistence.repos.training.findCandidateByRun(cycle.trainingRunId);
    if (!candidate) {
      throw notFound("Candidate", cycle.trainingRunId);
    }
    const version = await this.persistence.repos.evaluation.findVersion(objective.benchmarkVersionId);
    const itemCount = version ? (await this.persistence.repos.evaluation.listItems(version.id)).length : 0;
    const budget = await this.persistence.repos.learning.findBudget(cycle.id);
    if (budget && budget.usedInferenceCalls + itemCount * 2 > budget.maxInferenceCalls) {
      throw new DomainError("BUDGET_EXCEEDED", "The learning cycle inference budget is exhausted", 422);
    }
    let result: Awaited<ReturnType<EvaluationService["run"]>>;
    try {
      result = await this.evaluation.run(ctx, { versionId: objective.benchmarkVersionId, candidateId: candidate.id, source: "live" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "evaluation failed";
      if (cycle.trainingRunId) {
        const run = await this.persistence.repos.training.findRun(cycle.trainingRunId);
        if (run?.status === "evaluating") {
          await this.persistence.repos.training.updateRun(cycle.trainingRunId, { status: "failed", error: message.slice(0, 2000), finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
        }
      }
      await this.transition(ctx, cycle, "FAILED", message);
      throw error;
    }
    await this.persistence.repos.learning.updateCycle(cycle.id, { evaluationRunId: result.runId, updatedAt: this.now().toISOString() });
    if (budget) {
      await this.persistence.repos.learning.updateBudget(cycle.id, { usedInferenceCalls: budget.usedInferenceCalls + itemCount * 2 });
    }
    return { cycleId, evaluationRunId: result.runId, summary: result.summary, repeated: false };
  }

  async applyGate(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:gate:decide");
    const cycle = await this.requireCycle(cycleId);
    if (!cycle.evaluationRunId) {
      throw new DomainError("INVALID_STATE", "The gate requires a stored evaluation", 409);
    }
    if (cycle.gateDecision) {
      return { cycleId, decision: cycle.gateDecision, repeated: true };
    }
    const decision = await this.evaluation.decide(ctx, cycle.evaluationRunId);
    if (decision.decision === "PASS") {
      await this.persistence.repos.learning.updateCycle(cycle.id, { gateDecision: decision.decision, updatedAt: this.now().toISOString() });
      await this.transition(ctx, cycle, "AWAITING_PROMOTION", decision.rationale);
      return { cycleId, decision: decision.decision, repeated: false };
    }
    const status = decision.decision === "INCONCLUSIVE" ? "INCONCLUSIVE" : "REJECTED";
    await this.persistence.repos.learning.updateCycle(cycle.id, { gateDecision: decision.decision, updatedAt: this.now().toISOString() });
    await this.finish(ctx, { ...cycle, gateDecision: decision.decision }, status, "NO_VERIFIED_IMPROVEMENT", false, decision.rationale);
    return { cycleId, decision: decision.decision, repeated: false };
  }

  async adopt(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "learning:approve");
    const cycle = await this.requireCycle(cycleId);
    if (cycle.gateDecision !== "PASS" || cycle.status !== "AWAITING_PROMOTION") {
      throw new DomainError("NOT_APPROVED", "Only a PASS gate can be adopted, and adoption still requires this authorization", 409);
    }
    if (!cycle.trainingRunId) {
      throw new DomainError("INVALID_STATE", "The adopted cycle has no artifact", 409);
    }
    const candidate = await this.persistence.repos.training.findCandidateByRun(cycle.trainingRunId);
    if (!candidate || candidate.id === REVOKED_M5_CANDIDATE_ID || candidate.status === "revoked" || candidate.status === "quarantined") {
      throw new DomainError("NOT_APPROVED", "The historical or revoked candidate cannot be restored", 409);
    }
    if (!cycle.evaluationRunId) {
      throw new DomainError("INVALID_STATE", "Adoption requires the stored evaluation", 409);
    }
    const improvement = await this.verifyImprovement(ctx, cycleId);
    const deployment = assessDeployment({
      classification: improvement.classification,
      safetyGate: cycle.gateDecision,
      approved: true,
      compatible: improvement.evidence.familyCompatible === true,
      revoked: false,
      contaminated: improvement.evidence.contaminated === true,
      purpose: "improvement",
    });
    await this.recordDeployment(ctx, cycle.id, improvement.id, "improvement", deployment.eligibility, deployment.eligibility === "eligible", deployment.verifiedImprovement ? "Improvement deployment authorized" : improvement.rationale);
    const qwenBefore = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    if (!deployment.verifiedImprovement) {
      await this.finish(ctx, cycle, "REJECTED", "NO_VERIFIED_IMPROVEMENT", false, improvement.rationale);
      return { cycleId, outcome: "NO_VERIFIED_IMPROVEMENT" as const, adopted: false, productionUnchanged: true, improvement };
    }
    await this.finish(ctx, cycle, "ADOPTED", "MODEL_WEIGHT_IMPROVEMENT", true, "Task improvement was verified. Production Qwen routing was not changed.");
    const qwenAfter = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    if (qwenBefore?.status !== qwenAfter?.status || qwenBefore?.artifactUri !== qwenAfter?.artifactUri) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Adoption changed the production model row", 409);
    }
    return { cycleId, outcome: "MODEL_WEIGHT_IMPROVEMENT" as const, adopted: true, productionUnchanged: true };
  }

  async verifyImprovement(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    await this.requireDepartmentSlug(ctx, "evaluation");
    const cycle = await this.requireCycle(cycleId);
    if (!cycle.evaluationRunId) {
      throw new DomainError("INVALID_STATE", "Improvement verification requires an evaluation", 409);
    }
    const existing = await this.persistence.repos.learning.findImprovement(cycle.evaluationRunId, IMPROVEMENT_POLICY.version);
    if (existing) {
      return existing;
    }
    const report = await this.evaluation.getReport(ctx, cycle.evaluationRunId);
    const summary = report.summary as {
      taskBaseline?: number;
      taskCandidate?: number;
      formatBaseline?: number;
      formatCandidate?: number;
      sampleSize?: number;
      paired?: { bothCorrect: number; baselineOnly: number; candidateOnly: number };
      candidateId?: string;
      contract?: { comparison?: { comparable?: boolean } };
    };
    const paired = summary.paired;
    const candidate = cycle.trainingRunId ? await this.persistence.repos.training.findCandidateByRun(cycle.trainingRunId) : null;
    const verdict = verifyImprovement({
      sampleSize: summary.sampleSize ?? 0,
      taskBaseline: summary.taskBaseline ?? 0,
      taskCandidate: summary.taskCandidate ?? 0,
      formatBaseline: summary.formatBaseline ?? 0,
      formatCandidate: summary.formatCandidate ?? 0,
      baselineOnly: paired?.baselineOnly ?? null,
      candidateOnly: paired?.candidateOnly ?? null,
      taskBaselineCorrect: paired ? paired.bothCorrect + paired.baselineOnly : null,
      taskCandidateCorrect: paired ? paired.bothCorrect + paired.candidateOnly : null,
      checksumsMatch: true,
      contaminated: false,
      familyCompatible: candidate?.id !== REVOKED_M5_CANDIDATE_ID,
      evaluationPresent: true,
      benchmarkValid: (summary.sampleSize ?? 0) > 0,
      retentionPresent: false,
      retentionPassed: false,
      comparisonEligible: summary.contract?.comparison?.comparable === true,
    });
    const preview = assessDeployment({
      classification: verdict.classification,
      safetyGate: cycle.gateDecision ?? "INCONCLUSIVE",
      approved: true,
      compatible: true,
      revoked: candidate?.status === "revoked" || candidate?.id === REVOKED_M5_CANDIDATE_ID,
      contaminated: false,
      purpose: "improvement",
    });
    const row = {
      id: randomUUID(),
      evaluationRunId: cycle.evaluationRunId,
      cycleId: cycle.id,
      policyVersion: IMPROVEMENT_POLICY.version,
      policyHash: improvementPolicyHash(),
      safetyGate: cycle.gateDecision ?? "UNRECORDED",
      safetyGateVersion: GATE_POLICY.version,
      classification: verdict.classification,
      deploymentEligibility: preview.eligibility,
      baselineRef: "gemma-3-270m-base",
      candidateId: candidate?.id ?? summary.candidateId ?? null,
      sampleCount: summary.sampleSize ?? 0,
      effectSize: verdict.effectSize,
      uncertainty: verdict.uncertainty,
      retention: { present: false, passed: false },
      evidence: { familyCompatible: true, contaminated: false, pValue: verdict.pValue, claimSignificance: verdict.claimSignificance, limitations: verdict.limitations, formatBaseline: summary.formatBaseline ?? 0, formatCandidate: summary.formatCandidate ?? 0 },
      rationale: verdict.rationale,
      decidedBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.learning.insertImprovement(row);
    await this.persistence.repos.audit.append({
      eventType: "learning.improvement_verified",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "learning_cycle",
      targetId: cycle.id,
      action: "learning.improvement_verified",
      correlationId: ctx.correlationId,
      beforeState: { gate: cycle.gateDecision, outcomeKind: cycle.outcomeKind },
      afterState: { classification: verdict.classification, policy: IMPROVEMENT_POLICY.version },
      metadata: { evaluationRunId: cycle.evaluationRunId },
    });
    return row;
  }

  async viewImprovement(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    const cycle = await this.requireCycle(cycleId);
    return { data: await this.persistence.repos.learning.listImprovements(cycle.id) };
  }

  async constrainBudget(ctx: RequestContext, cycleId: string, limits: { maxInferenceCalls?: number; maxTrainingSteps?: number; maxRuntimeMs?: number }) {
    this.authorizer.assert(ctx.actor, "learning:approve");
    const budget = await this.persistence.repos.learning.findBudget(cycleId);
    if (!budget) {
      throw notFound("Learning budget", cycleId);
    }
    if ((limits.maxInferenceCalls ?? budget.maxInferenceCalls) > budget.maxInferenceCalls || (limits.maxTrainingSteps ?? budget.maxTrainingSteps) > budget.maxTrainingSteps || (limits.maxRuntimeMs ?? budget.maxRuntimeMs) > budget.maxRuntimeMs) {
      throw new DomainError("AUTHORIZATION_DENIED", "A learning budget cannot be increased", 403);
    }
    await this.persistence.repos.learning.updateBudget(cycleId, {
      maxInferenceCalls: limits.maxInferenceCalls ?? budget.maxInferenceCalls,
      maxTrainingSteps: limits.maxTrainingSteps ?? budget.maxTrainingSteps,
      maxRuntimeMs: limits.maxRuntimeMs ?? budget.maxRuntimeMs,
    });
    return this.persistence.repos.learning.findBudget(cycleId);
  }

  async authorizeExceptional(ctx: RequestContext, cycleId: string, rationale: string) {
    this.authorizer.assert(ctx.actor, "learning:approve");
    const cycle = await this.requireCycle(cycleId);
    const improvement = cycle.evaluationRunId ? await this.persistence.repos.learning.findImprovement(cycle.evaluationRunId, IMPROVEMENT_POLICY.version) : null;
    const classification = improvement?.classification ?? "NO_VERIFIED_IMPROVEMENT";
    const decision = assessDeployment({
      classification,
      safetyGate: cycle.gateDecision ?? "INCONCLUSIVE",
      approved: true,
      compatible: true,
      revoked: false,
      contaminated: false,
      purpose: "exceptional",
    });
    const recorded = await this.recordDeployment(ctx, cycleId, improvement?.id ?? null, "exceptional", decision.eligibility, false, rationale);
    const qwen = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    return { ...recorded, verifiedImprovement: false, productionStatus: qwen?.status ?? null, productionArtifact: qwen?.artifactUri ?? null };
  }

  private async recordDeployment(ctx: RequestContext, cycleId: string, improvementDecisionId: string | null, purpose: "improvement" | "exceptional", eligibility: "eligible" | "ineligible" | "exceptional", adopted: boolean, rationale: string) {
    const existing = await this.persistence.repos.learning.findDeployment(cycleId, purpose);
    if (existing) {
      return existing;
    }
    const row = { id: randomUUID(), cycleId, improvementDecisionId, purpose, eligibility, adopted, rationale, decidedBy: ctx.actor.principalId, createdAt: this.now().toISOString() };
    await this.persistence.repos.learning.insertDeployment(row);
    await this.persistence.repos.audit.append({
      eventType: "learning.deployment_decided",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "learning_cycle",
      targetId: cycleId,
      action: "learning.deployment_decided",
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: { purpose, eligibility, adopted },
      metadata: {},
    });
    return row;
  }

  async publishResult(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    const cycle = await this.requireCycle(cycleId);
    if (!TERMINAL.has(cycle.status) && cycle.status !== "AWAITING_PROMOTION") {
      throw new DomainError("INVALID_STATE", "The learning result is not ready to publish", 409);
    }
    const outcome = cycle.outcomeKind ?? "NO_VERIFIED_IMPROVEMENT";
    await this.notify(ctx, {
      messageType: "LEARNING_CYCLE_RESULT",
      recipientDepartmentId: cycle.departmentId,
      idempotencyKey: `learning.result.${cycle.id}.${cycle.status}.${outcome}`,
      payload: { cycleId: cycle.id, status: cycle.status, outcomeKind: outcome },
    });
    return { cycleId, status: cycle.status, outcome };
  }

  async transferKnowledge(ctx: RequestContext, input: { destinationDepartmentId: string; sourceMemoryId: string; idempotencyKey: string }) {
    this.authorizer.assert(ctx.actor, "learning:transfer");
    if (!ctx.actor.departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "Knowledge transfer requires a department", 403);
    }
    const existing = await this.persistence.repos.learning.findTransferByKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const memory = await this.memories.getMemory(ctx, input.sourceMemoryId);
    if (memory.provenance === "model_generated" || memory.status === "forgotten") {
      throw new DomainError("UNVERIFIED_SIGNAL", "Model-generated or forgotten content cannot be transferred as verified knowledge", 422);
    }
    const cycle = this.newCycle(ctx.actor.departmentId, `transfer:${input.idempotencyKey}`, "knowledge_transfer", ctx.actor.principalId);
    cycle.status = "EXECUTING";
    const transfer = {
      id: randomUUID(),
      originDepartmentId: ctx.actor.departmentId,
      destinationDepartmentId: input.destinationDepartmentId,
      sourceMemoryId: memory.id,
      summary: memory.summary.slice(0, 1000),
      provenance: memory.provenance,
      trust: memory.provenance,
      evidence: { sourceMemoryId: memory.id, contentHash: memory.contentHash },
      status: "pending" as const,
      version: 1,
      restrictions: "Recipient memory only. Not colony-verified unless accepted.",
      idempotencyKey: input.idempotencyKey,
      cycleId: cycle.id,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    cycle.transferId = transfer.id;
    await this.persistence.transaction(async (repos) => {
      await repos.learning.insertCycle(cycle);
      await repos.learning.insertBudget({ id: randomUUID(), cycleId: cycle.id, maxInferenceCalls: 10, maxTrainingSteps: 0, maxRuntimeMs: 60_000, usedInferenceCalls: 0, usedTrainingSteps: 0, usedRuntimeMs: 0 });
      await repos.learning.insertTransfer(transfer);
      await repos.learning.insertEvent({ id: randomUUID(), cycleId: cycle.id, fromStatus: "OBSERVED", toStatus: "EXECUTING", actorId: ctx.actor.principalId, reason: "knowledge transfer sent", createdAt: this.now().toISOString() });
    });
    await this.notify(ctx, {
      messageType: "KNOWLEDGE_TRANSFER",
      recipientDepartmentId: input.destinationDepartmentId,
      idempotencyKey: `learning.transfer.${transfer.id}`,
      payload: { transferId: transfer.id, originDepartmentId: transfer.originDepartmentId, destinationDepartmentId: transfer.destinationDepartmentId, trust: memory.provenance },
    });
    return transfer;
  }

  async validateTransfer(ctx: RequestContext, transferId: string, decision: "accept" | "reject", reason: string) {
    this.authorizer.assert(ctx.actor, "learning:validate");
    const transfer = await this.persistence.repos.learning.findTransfer(transferId);
    if (!transfer) {
      throw notFound("Knowledge transfer", transferId);
    }
    if (ctx.actor.departmentId !== transfer.destinationDepartmentId && ctx.actor.role !== "system_administrator") {
      throw new DomainError("AUTHORIZATION_DENIED", "Only the destination department can validate this transfer", 403);
    }
    const existing = await this.persistence.repos.learning.findValidation(transferId);
    if (existing) {
      return existing;
    }
    const source = transfer.sourceMemoryId ? await this.persistence.repos.memories.findById(transfer.sourceMemoryId) : null;
    const reject = decision === "reject" || transfer.trust === "model_generated" || transfer.provenance === "model_generated" || source?.status === "forgotten";
    let acceptedMemoryId: string | null = null;
    if (!reject) {
      const created = await this.memories.createMemory(ctx, {
        scope: "department",
        category: "semantic",
        title: `from ${transfer.originDepartmentId}`,
        summary: transfer.summary,
        content: source?.content ?? transfer.summary,
        provenance: transfer.provenance === "system_observed" ? "system_observed" : "user_provided",
        idempotencyKey: `accepted-${transfer.id}`,
      });
      acceptedMemoryId = created.id;
    }
    const row = {
      id: randomUUID(),
      transferId,
      decision: reject ? "reject" as const : "accept" as const,
      decidedBy: ctx.actor.principalId,
      reason: source?.status === "forgotten" ? "Forgotten content cannot be promoted" : reject && decision === "accept" ? "Unverified model output was rejected" : reason,
      acceptedMemoryId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.learning.insertValidation(row);
    await this.persistence.repos.learning.updateTransfer(transferId, { status: row.decision === "accept" ? "accepted" : "rejected" });
    if (transfer.cycleId) {
      const cycle = await this.requireCycle(transfer.cycleId);
      await this.finish(ctx, cycle, row.decision === "accept" ? "ADOPTED" : "REJECTED", row.decision === "accept" ? "MEMORY_IMPROVEMENT" : "NO_VERIFIED_IMPROVEMENT", row.decision === "accept", row.reason);
    }
    await this.notify(ctx, {
      messageType: "KNOWLEDGE_VALIDATION",
      recipientDepartmentId: transfer.originDepartmentId,
      idempotencyKey: `learning.validation.${transfer.id}`,
      payload: { transferId, decision: row.decision },
    });
    return row;
  }

  async proposeForgetting(ctx: RequestContext, memoryId: string, idempotencyKey: string) {
    this.authorizer.assert(ctx.actor, "memory:forget:request");
    await this.requireDepartmentSlug(ctx, "memory-and-forgetting");
    return this.evaluation.requestForgetting(ctx, memoryId, idempotencyKey);
  }

  async assignModel(ctx: RequestContext, input: { departmentId: string; role: "shared_base" | "experimental_adapter" | "capability_adapter" | "fallback"; registryModelId: string; candidateId?: string }) {
    this.authorizer.assert(ctx.actor, "learning:approve");
    const registry = await this.persistence.repos.models.findById(input.registryModelId);
    if (!registry) {
      throw notFound("Model", input.registryModelId);
    }
    let trainableModelId: string | null = null;
    let adapterSha256: string | null = null;
    let family = registry.modelFamily;
    if (input.candidateId) {
      if (input.candidateId === REVOKED_M5_CANDIDATE_ID) {
        throw new DomainError("NOT_APPROVED", "The revoked M5 candidate stays revoked", 409);
      }
      const candidate = await this.persistence.repos.training.findCandidate(input.candidateId);
      if (!candidate || candidate.status === "revoked" || candidate.status === "quarantined") {
        throw new DomainError("NOT_APPROVED", "Only an active experimental candidate can be assigned", 409);
      }
      const adapter = await this.persistence.repos.training.findAdapter(candidate.adapterId);
      const trainable = adapter ? await this.persistence.repos.training.findTrainable(adapter.baseTrainableModelId) : null;
      if (!trainable || trainable.modelFamily !== "gemma-3" || registry.modelFamily !== "gemma-3" || registry.id === QWEN3_8B_MODEL_ID) {
        throw new DomainError("MODEL_INCOMPATIBLE", "A Gemma adapter cannot be routed onto Qwen", 422);
      }
      trainableModelId = trainable.id;
      family = trainable.modelFamily;
      const artifact = (await this.persistence.repos.training.listArtifacts(candidate.runId)).find((row) => row.id === adapter?.artifactId);
      adapterSha256 = artifact?.sha256 ?? null;
    }
    const qwenBefore = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    const versions = await this.persistence.repos.learning.listAssignments(input.departmentId);
    const row = {
      id: randomUUID(),
      departmentId: input.departmentId,
      role: input.role,
      registryModelId: registry.id,
      trainableModelId,
      candidateId: input.candidateId ?? null,
      adapterSha256,
      modelFamily: family,
      version: versions.length + 1,
      status: "active" as const,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.transaction(async (repos) => {
      await repos.learning.supersedeAssignments(input.departmentId);
      await repos.learning.insertAssignment(row);
    });
    const qwenAfter = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    if (qwenBefore?.status !== qwenAfter?.status || qwenBefore?.artifactUri !== qwenAfter?.artifactUri) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "An assignment changed the production model row", 409);
    }
    return row;
  }

  async executeTool(ctx: RequestContext, departmentId: string, tool: string, input: string) {
    this.authorizer.assert(ctx.actor, "learning:read");
    await this.requireOwnDepartment(ctx, departmentId);
    const allowed = await this.toolAllowed(departmentId, tool);
    if (!allowed) {
      throw new DomainError("AUTHORIZATION_DENIED", `Department ${departmentId} is not approved to use ${tool}`, 403);
    }
    if (tool === "exact_arithmetic") {
      const match = /^(-?\d+)\s*\+\s*(-?\d+)$/.exec(input.trim());
      if (!match) {
        throw new DomainError("VALIDATION_ERROR", "exact_arithmetic accepts only integer addition", 422);
      }
      return { tool, output: String(Number(match[1]) + Number(match[2])), modelCopied: false };
    }
    throw new DomainError("AUTHORIZATION_DENIED", "The requested tool is not registered", 403);
  }

  async cancel(ctx: RequestContext, cycleId: string, reason: string) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const cycle = await this.requireCycle(cycleId);
    if (TERMINAL.has(cycle.status) || cycle.status === "EVALUATING") {
      throw new DomainError("INVALID_STATE", "This learning cycle can no longer be cancelled", 409);
    }
    if (cycle.status === "EXECUTING") {
      this.authorizer.assert(ctx.actor, "training:cancel");
      const candidate = cycle.trainingRunId ? await this.persistence.repos.training.findCandidateByRun(cycle.trainingRunId) : null;
      if (candidate) {
        throw new DomainError("INVALID_STATE", "An adapter already exists, so the running job cannot be interrupted safely", 409);
      }
      if (cycle.trainingRunId) {
        await this.training.cancel(ctx, cycle.trainingRunId);
      }
    } else if (cycle.trainingRunId) {
      const run = await this.persistence.repos.training.findRun(cycle.trainingRunId);
      if (run && (run.status === "proposed" || run.status === "awaiting_approval" || run.status === "queued")) {
        this.authorizer.assert(ctx.actor, "training:cancel");
        await this.training.cancel(ctx, cycle.trainingRunId);
      }
    }
    await this.transition(ctx, cycle, "CANCELLED", reason);
    return { cycleId, status: "CANCELLED" as const };
  }

  async resume(ctx: RequestContext, cycleId: string) {
    this.authorizer.assert(ctx.actor, "learning:read");
    const cycle = await this.requireCycle(cycleId);
    const run = cycle.trainingRunId ? await this.persistence.repos.training.findRun(cycle.trainingRunId) : null;
    let next = "none";
    if (cycle.status === "AWAITING_APPROVAL") next = "approve";
    else if (cycle.status === "APPROVED") next = "execute";
    else if (cycle.status === "EVALUATING" && !cycle.evaluationRunId) next = "evaluate";
    else if (cycle.status === "EVALUATING" && cycle.evaluationRunId && !cycle.gateDecision) next = "gate";
    else if (cycle.status === "AWAITING_PROMOTION") next = "adopt";
    return { cycle, trainingStatus: run?.status ?? null, next, executed: false };
  }

  async overview(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "learning:read");
    const cycles = await this.persistence.repos.learning.listCycles();
    const gaps = await this.persistence.repos.learning.listGaps();
    const outcomes = await Promise.all(cycles.map((cycle) => this.persistence.repos.learning.findOutcome(cycle.id)));
    return {
      gaps: gaps.length,
      openGaps: gaps.filter((gap) => gap.status === "observed" || gap.status === "validated" || gap.status === "aggregated").length,
      cycles: cycles.length,
      byStatus: countBy(cycles.map((cycle) => cycle.status)),
      outcomes: countBy(outcomes.flatMap((row) => (row ? [row.kind] : []))),
    };
  }

  async listCycles(ctx: RequestContext, departmentId?: string) {
    this.authorizer.assert(ctx.actor, "learning:read");
    return { data: await this.persistence.repos.learning.listCycles(departmentId) };
  }

  async getCycle(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "learning:read");
    const cycle = await this.requireCycle(id);
    return { cycle, events: await this.persistence.repos.learning.listEvents(id), outcome: await this.persistence.repos.learning.findOutcome(id), budget: await this.persistence.repos.learning.findBudget(id) };
  }

  private newCycle(departmentId: string, key: string, method: LearningMechanism, createdBy: string): LearningCycleRecord {
    const now = this.now().toISOString();
    return {
      id: randomUUID(),
      objectiveId: null,
      departmentId,
      status: "OBSERVED",
      method,
      outcomeKind: null,
      trainingRunId: null,
      evaluationRunId: null,
      gateDecision: null,
      transferId: null,
      memoryId: null,
      idempotencyKey: key,
      correlationId: randomUUID(),
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async transition(ctx: RequestContext, cycle: LearningCycleRecord, to: LearningCycleStatus, reason: string) {
    const current = await this.requireCycle(cycle.id);
    if (current.status === to) {
      return current;
    }
    assertLearningTransition(current.status, to);
    await this.persistence.transaction(async (repos) => {
      await repos.learning.updateCycle(cycle.id, { status: to, updatedAt: this.now().toISOString() });
      await repos.learning.insertEvent({ id: randomUUID(), cycleId: cycle.id, fromStatus: current.status, toStatus: to, actorId: ctx.actor.principalId, reason, createdAt: this.now().toISOString() });
      await repos.audit.append({
        eventType: "learning.transition",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "learning_cycle",
        targetId: cycle.id,
        action: "learning.transition",
        correlationId: ctx.correlationId,
        beforeState: { status: current.status },
        afterState: { status: to },
        metadata: { reason },
      });
    });
    return this.requireCycle(cycle.id);
  }

  private async finish(ctx: RequestContext, cycle: LearningCycleRecord, status: LearningCycleStatus, kind: OutcomeKind, verified: boolean, summary: string) {
    await this.transition(ctx, cycle, status, summary);
    const existing = await this.persistence.repos.learning.findOutcome(cycle.id);
    if (!existing) {
      await this.persistence.repos.learning.insertOutcome({
        id: randomUUID(),
        cycleId: cycle.id,
        kind: verified ? kind : "NO_VERIFIED_IMPROVEMENT",
        verified,
        summary: summary.slice(0, 500),
        evidence: { gate: cycle.gateDecision, method: cycle.method },
        createdAt: this.now().toISOString(),
      });
      await this.persistence.repos.learning.updateCycle(cycle.id, { outcomeKind: verified ? kind : "NO_VERIFIED_IMPROVEMENT", updatedAt: this.now().toISOString() });
    }
  }

  private async toolAllowed(departmentId: string, tool: string): Promise<boolean> {
    const capabilities = await this.persistence.repos.learning.listCapabilities(departmentId);
    for (const capability of capabilities) {
      const versions = await this.persistence.repos.learning.listCapabilityVersions(capability.id);
      if (versions.some((version) => version.status === "approved" && version.toolNames.includes(tool))) {
        return true;
      }
    }
    return false;
  }

  private async notify(ctx: RequestContext, input: { messageType: "TRAINING_REQUEST" | "LEARNING_CYCLE_RESULT" | "KNOWLEDGE_TRANSFER" | "KNOWLEDGE_VALIDATION"; recipientDepartmentId: string; idempotencyKey: string; payload: Record<string, unknown> }) {
    if (!ctx.actor.agentId) {
      return;
    }
    await this.messages.send(ctx, { messageType: input.messageType, recipientDepartmentId: input.recipientDepartmentId, priority: 5, idempotencyKey: input.idempotencyKey, payload: input.payload });
  }

  private async requireOwnDepartment(ctx: RequestContext, departmentId: string) {
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    if (ctx.actor.departmentId !== departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "A department can record learning only for itself", 403);
    }
  }

  private async requireDepartmentSlug(ctx: RequestContext, slug: string) {
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    const department = ctx.actor.departmentId ? await this.persistence.repos.departments.findById(ctx.actor.departmentId) : null;
    if (department?.slug !== slug) {
      throw new DomainError("AUTHORIZATION_DENIED", `This action belongs to the ${slug} department`, 403);
    }
  }

  private async departmentIdBySlug(slug: string): Promise<string> {
    const page = await this.persistence.repos.departments.list({ limit: 100, cursor: null });
    const found = page.data.find((row) => row.slug === slug);
    if (!found) {
      throw notFound("Department", slug);
    }
    return found.id;
  }

  private async requireDepartment(id: string) {
    const department = await this.persistence.repos.departments.findById(id);
    if (!department) {
      throw notFound("Department", id);
    }
    return department;
  }

  private async requireGap(id: string) {
    const gap = await this.persistence.repos.learning.findGap(id);
    if (!gap) {
      throw notFound("Capability gap", id);
    }
    return gap;
  }

  private async requireCycle(id: string) {
    const cycle = await this.persistence.repos.learning.findCycle(id);
    if (!cycle) {
      throw notFound("Learning cycle", id);
    }
    return cycle;
  }

  private async requireCycleByKey(key: string) {
    const cycle = await this.persistence.repos.learning.findCycleByKey(key);
    if (!cycle) {
      throw notFound("Learning cycle", key);
    }
    return cycle;
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
