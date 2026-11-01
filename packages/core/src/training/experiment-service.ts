import { randomUUID } from "node:crypto";
import type { RequestContext } from "../context.js";
import { DomainError } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { Persistence, StoredExperiment } from "../ports/repositories.js";
import { TRAINING_METHODS, assertMethodExecutable, planExperiments, type ExperimentRecord, type PlanRecommendation } from "./experiment-planner.js";
import { meanExposures, stopDecision } from "./stability.js";

export interface ExperimentInput {
  idempotencyKey: string;
  methodId: string;
  modelId: string;
  modelRevision: string;
  adapterSha256: string | null;
  problem: string;
  datasetSize: number;
  learningRate: number;
  steps: number;
  target: "answer" | "structured";
  seed: number;
  devAccuracy: number | null;
  baselineAccuracy: number | null;
  sealedAccuracy: number | null;
  retentionOk: boolean | null;
  failureClass: string | null;
  recommendation: string;
  evidencePath: string;
  stopped?: boolean;
}

export class ExperimentService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listMethods(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "training:read");
    return { methods: TRAINING_METHODS };
  }

  async record(ctx: RequestContext, input: ExperimentInput): Promise<{ experiment: StoredExperiment; repeated: boolean }> {
    this.authorizer.assert(ctx.actor, "training:propose");
    await this.requireDepartment(ctx, "weight-optimization");
    assertMethodExecutable(input.methodId, "qwen3");
    if (/^\s*promote\b/i.test(input.recommendation)) {
      throw new DomainError("NOT_APPROVED", "An experiment record cannot recommend promotion", 403);
    }
    const existing = await this.persistence.repos.experiments.findByKey(input.idempotencyKey);
    if (existing) {
      return { experiment: existing, repeated: true };
    }
    const stored = await this.persistence.transaction(async (repos) => {
      const row = await repos.experiments.insert(this.toStored(ctx, input));
      await repos.audit.append({
        eventType: "training.experiment_recorded",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "training_experiment",
        targetId: row.id,
        action: "training.experiment_recorded",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { methodId: row.methodId, steps: row.steps, learningRate: row.learningRate, failureClass: row.failureClass, evidencePath: row.evidencePath },
        metadata: { deployment: "ineligible", rawOutputsStored: false },
      });
      return row;
    });
    return { experiment: stored, repeated: false };
  }

  async history(ctx: RequestContext): Promise<StoredExperiment[]> {
    this.authorizer.assert(ctx.actor, "training:read");
    await this.requireDepartment(ctx, "weight-optimization");
    return this.persistence.repos.experiments.list();
  }

  async plan(ctx: RequestContext, input: { problem: string; baseAccuracy: number | null; budgetMaxSteps: number }): Promise<{ recommendations: PlanRecommendation[] }> {
    this.authorizer.assert(ctx.actor, "training:propose");
    await this.requireDepartment(ctx, "weight-optimization");
    if (input.budgetMaxSteps < 0 || input.budgetMaxSteps > 200) {
      throw new DomainError("BUDGET_EXCEEDED", "The experiment budget is outside the local limit", 422);
    }
    const history = (await this.persistence.repos.experiments.list()).map(toPlannerRecord);
    return { recommendations: planExperiments({ problem: input.problem, history, budgetMaxSteps: input.budgetMaxSteps, baseAccuracy: input.baseAccuracy }) };
  }

  async stop(ctx: RequestContext, input: ExperimentInput & { peakMemoryBytes: number | null; maxMemoryBytes?: number; lossFinite: boolean; datasetValid: boolean; modelCompatible: boolean; evaluationPresent: boolean }): Promise<{ experiment: StoredExperiment; reason: string }> {
    if (ctx.actor.role !== "system_administrator") {
      this.authorizer.assert(ctx.actor, "training:read");
      await this.requireDepartment(ctx, "monitoring");
    }
    const decision = stopDecision({
      baselineAccuracy: input.baselineAccuracy,
      candidateAccuracy: input.devAccuracy,
      peakMemoryBytes: input.peakMemoryBytes,
      maxMemoryBytes: input.maxMemoryBytes,
      steps: input.steps,
      lossFinite: input.lossFinite,
      datasetValid: input.datasetValid,
      modelCompatible: input.modelCompatible,
      evaluationPresent: input.evaluationPresent,
    });
    const reason = decision.reason;
    if (!decision.stop || reason === null) {
      throw new DomainError("INVALID_STATE", "This experiment has not met a stop condition", 409);
    }
    const existing = await this.persistence.repos.experiments.findByKey(input.idempotencyKey);
    if (existing) {
      return { experiment: existing, reason };
    }
    const stored = await this.persistence.transaction(async (repos) => {
      const row = await repos.experiments.insert(this.toStored(ctx, { ...input, stopped: true, failureClass: input.failureClass ?? "stopped", recommendation: reason }));
      await repos.audit.append({
        eventType: "training.experiment_stopped",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "training_experiment",
        targetId: row.id,
        action: "training.experiment_stopped",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { reason, steps: row.steps },
        metadata: { deployment: "ineligible", promotionApproved: false },
      });
      return row;
    });
    return { experiment: stored, reason };
  }

  private toStored(ctx: RequestContext, input: ExperimentInput): StoredExperiment {
    return {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      methodId: input.methodId,
      modelId: input.modelId,
      modelRevision: input.modelRevision,
      adapterSha256: input.adapterSha256,
      problem: input.problem,
      datasetSize: input.datasetSize,
      learningRate: input.learningRate,
      steps: input.steps,
      exposures: meanExposures(input.steps, input.datasetSize),
      target: input.target,
      seed: input.seed,
      devAccuracy: input.devAccuracy,
      baselineAccuracy: input.baselineAccuracy,
      sealedAccuracy: input.sealedAccuracy,
      retentionOk: input.retentionOk,
      failureClass: input.failureClass,
      recommendation: input.recommendation,
      evidencePath: input.evidencePath,
      stopped: input.stopped ?? false,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
  }

  private async requireDepartment(ctx: RequestContext, slug: string) {
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    const department = ctx.actor.departmentId ? await this.persistence.repos.departments.findById(ctx.actor.departmentId) : null;
    if (department?.slug !== slug) {
      throw new DomainError("AUTHORIZATION_DENIED", `This action belongs to the ${slug} department`, 403);
    }
  }
}

function toPlannerRecord(row: StoredExperiment): ExperimentRecord {
  return {
    id: row.id,
    methodId: row.methodId,
    steps: row.steps,
    learningRate: row.learningRate,
    datasetSize: row.datasetSize,
    target: row.target,
    seed: row.seed,
    devAccuracy: row.devAccuracy,
    baselineAccuracy: row.baselineAccuracy,
    sealedAccuracy: row.sealedAccuracy,
    retentionOk: row.retentionOk,
    failureClass: row.failureClass,
    evidencePath: row.evidencePath,
  };
}
