import type { RequestContext } from "../context.js";
import { DomainError } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { Persistence } from "../ports/repositories.js";
import {
  departmentLearningExperimentSchema,
  fingerprintLearningExperiment,
  LEARNING_ROLE_DEPARTMENTS,
  type DepartmentLearningExperiment,
} from "./department-learning-spec.js";
import {
  assertValidatedLearningExperiment,
  validateDepartmentLearningExperiment,
  type LearningValidationResult,
} from "./department-learning-validate.js";
import {
  assertTrainingCodePatch,
  computePatchContentFingerprint,
  validateTrainingCodePatch,
  type CodePatchValidationResult,
} from "./training-code-patch.js";

/**
 * C1.8B foundation service: propose/validate department-directed learning experiments.
 * Does not launch trainers, mutate Ollama, or apply migrations.
 */
export class SelfTrainingExperimentService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  describeResponsibilities() {
    return {
      math: {
        slug: "math",
        responsibilities: [
          "Identify skill weaknesses from evaluation evidence",
          "Request training for the math department",
          "Supply target skills and success criteria",
        ],
      },
      weightOptimization: {
        slug: LEARNING_ROLE_DEPARTMENTS.trainingMethodProposer,
        responsibilities: [
          "Propose training methods and configurations",
          "Propose training-code modifications with rationale",
          "Explain expected improvement without self-promoting adapters",
        ],
      },
      memoryAndForgetting: {
        slug: LEARNING_ROLE_DEPARTMENTS.provenanceReviewer,
        responsibilities: [
          "Review training-data provenance",
          "Flag duplicates and evaluation leakage",
          "Surface prior experiment findings and retention decisions",
        ],
      },
      engineering: {
        slug: LEARNING_ROLE_DEPARTMENTS.codeImplementer,
        responsibilities: [
          "Review candidate training-code patches",
          "Implement allowlisted patch proposals in isolated workspaces (later milestone)",
        ],
      },
      evaluation: {
        slug: LEARNING_ROLE_DEPARTMENTS.independentEvaluator,
        responsibilities: [
          "Define independent evaluation requirements",
          "Measure accuracy, regressions, cost, and reproducibility",
          "Gate promotion; never let a requester self-approve",
        ],
      },
    };
  }

  async validateExperiment(
    ctx: RequestContext,
    experiment: unknown,
  ): Promise<{ experiment: DepartmentLearningExperiment; validation: LearningValidationResult }> {
    this.authorizer.assert(ctx.actor, "learning:propose");
    const departmentSlug = await this.actorDepartmentSlug(ctx);
    const validation = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: ctx.actor.principalId,
        agentId: ctx.actor.agentId,
        departmentSlug,
        role: ctx.actor.role,
      },
      now: this.now,
    });
    const parsed = departmentLearningExperimentSchema.parse(experiment);
    await this.recordAudit(ctx, parsed, validation);
    if (!validation.ok) {
      return { experiment: parsed, validation };
    }
    return assertValidatedLearningExperiment({
      experiment: parsed,
      actor: {
        principalId: ctx.actor.principalId,
        agentId: ctx.actor.agentId,
        departmentSlug,
        role: ctx.actor.role,
      },
      now: this.now,
    });
  }

  async validateCodePatch(ctx: RequestContext, patch: unknown): Promise<CodePatchValidationResult> {
    this.authorizer.assert(ctx.actor, "training:propose");
    const result = validateTrainingCodePatch(patch);
    if (result.ok) {
      assertTrainingCodePatch(patch);
    }
    return result;
  }

  fingerprint(experiment: DepartmentLearningExperiment): string {
    return fingerprintLearningExperiment(experiment);
  }

  patchFingerprint = computePatchContentFingerprint;

  private async actorDepartmentSlug(ctx: RequestContext): Promise<string | null> {
    if (!ctx.actor.departmentId) {
      return null;
    }
    const department = await this.persistence.repos.departments.findById(ctx.actor.departmentId);
    return department?.slug ?? null;
  }

  private async recordAudit(
    ctx: RequestContext,
    experiment: DepartmentLearningExperiment,
    validation: LearningValidationResult,
  ): Promise<void> {
    await this.persistence.repos.audit.append({
      eventType: validation.ok ? "learning.experiment_validated" : "learning.experiment_rejected",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "department_learning_experiment",
      targetId: experiment.experimentId,
      action: validation.ok ? "learning.experiment_validated" : "learning.experiment_rejected",
      correlationId: ctx.correlationId,
      beforeState: null,
      afterState: {
        proposalFingerprint: validation.proposalFingerprint,
        status: validation.status,
        trainingLaunched: false,
        issueCodes: validation.issues.map((issue) => issue.code),
        requestingDepartmentSlug: experiment.requestingDepartmentSlug,
        targetDepartmentSlug: experiment.targetDepartmentSlug,
        baseModelAlias: experiment.baseModel.alias,
        baseModelDigest: experiment.baseModel.digest,
        evaluationSuite: `${experiment.evaluation.suiteId}@${experiment.evaluation.suiteVersion}`,
      },
      metadata: {
        specVersion: experiment.specVersion,
        codePatchPresent: Boolean(experiment.codePatch),
      },
    }).catch((error: unknown) => {
      throw new DomainError(
        "INTERNAL",
        error instanceof Error ? error.message : "Failed to append learning validation audit event",
        500,
      );
    });
  }
}
