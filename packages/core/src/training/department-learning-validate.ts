import { DomainError } from "../errors/domain-error.js";
import { methodById } from "./experiment-planner.js";
import {
  DEPARTMENT_LEARNING_SPEC_VERSION,
  departmentLearningExperimentSchema,
  fingerprintLearningExperiment,
  LEARNING_ROLE_DEPARTMENTS,
  type DepartmentLearningExperiment,
} from "./department-learning-spec.js";
import {
  computePatchContentFingerprint,
  validateTrainingCodePatch,
  type CodePatchValidationResult,
} from "./training-code-patch.js";
import { assertNotSelfDecision } from "./transitions.js";

export type LearningValidationCode =
  | "ok"
  | "invalid_spec"
  | "permission"
  | "dataset_provenance"
  | "evaluation_leakage"
  | "invalid_training_config"
  | "code_patch_rejected"
  | "self_approval"
  | "role_mismatch"
  | "identity_mismatch";

export interface LearningValidationIssue {
  code: LearningValidationCode;
  message: string;
  field?: string;
}

export interface LearningValidationResult {
  ok: boolean;
  specVersion: typeof DEPARTMENT_LEARNING_SPEC_VERSION;
  experimentId: string | null;
  proposalFingerprint: string | null;
  status: "validated" | "rejected";
  issues: LearningValidationIssue[];
  codePatch: CodePatchValidationResult | null;
  checkedAt: string;
  /** Explicitly records that no trainer was launched. */
  trainingLaunched: false;
}

export interface ValidateLearningExperimentInput {
  experiment: unknown;
  /** Actor presenting the proposal for validation. */
  actor: {
    principalId: string;
    agentId: string | null;
    departmentSlug: string | null;
    role: string;
  };
  /** Wall clock for immutable result. */
  now?: () => Date;
}

/**
 * Deterministic, non-executing validation of a department learning experiment.
 * Never launches training jobs.
 */
export function validateDepartmentLearningExperiment(
  input: ValidateLearningExperimentInput,
): LearningValidationResult {
  const checkedAt = (input.now ?? (() => new Date))().toISOString();
  const parsed = departmentLearningExperimentSchema.safeParse(input.experiment);
  if (!parsed.success) {
    return {
      ok: false,
      specVersion: DEPARTMENT_LEARNING_SPEC_VERSION,
      experimentId: null,
      proposalFingerprint: null,
      status: "rejected",
      issues: parsed.error.issues.slice(0, 12).map((issue) => ({
        code: "invalid_spec" as const,
        field: issue.path.join(".") || undefined,
        message: issue.message,
      })),
      codePatch: null,
      checkedAt,
      trainingLaunched: false,
    };
  }

  const experiment = parsed.data;
  const issues: LearningValidationIssue[] = [];
  const fingerprint = fingerprintLearningExperiment(experiment);

  if (experiment.specVersion !== DEPARTMENT_LEARNING_SPEC_VERSION) {
    issues.push({ code: "invalid_spec", message: "Unsupported department learning spec version" });
  }

  // Target department must match requesting department for self-directed learning in this milestone.
  if (experiment.requestingDepartmentSlug !== experiment.targetDepartmentSlug) {
    issues.push({
      code: "role_mismatch",
      field: "targetDepartmentSlug",
      message: "C1.8B only allows a department to request training for itself",
    });
  }

  validatePermissions(input.actor, experiment, issues);
  validateDatasets(experiment, issues);
  validateTrainingConfig(experiment, issues);
  validateApprovals(experiment, issues);

  let codePatch: CodePatchValidationResult | null = null;
  if (experiment.codePatch) {
    if (experiment.codePatch.proposedByDepartmentSlug !== LEARNING_ROLE_DEPARTMENTS.trainingMethodProposer
      && experiment.codePatch.proposedByDepartmentSlug !== LEARNING_ROLE_DEPARTMENTS.codeImplementer) {
      issues.push({
        code: "role_mismatch",
        field: "codePatch.proposedByDepartmentSlug",
        message: "Training-code patches must be proposed by weight-optimization or engineering",
      });
    }
    const expected = computePatchContentFingerprint(experiment.codePatch);
    if (experiment.codePatch.modifiedRevision !== expected) {
      issues.push({
        code: "code_patch_rejected",
        field: "codePatch.modifiedRevision",
        message: "modifiedRevision does not match the proposed diff fingerprint",
      });
    }
    codePatch = validateTrainingCodePatch(experiment.codePatch);
    if (!codePatch.ok) {
      for (const issue of codePatch.issues) {
        issues.push({
          code: "code_patch_rejected",
          field: issue.path,
          message: issue.message,
        });
      }
    }
  }

  // Preserve frozen model / evaluation identities: digest and suite refs must be present (already schema-enforced).
  if (!experiment.baseModel.digest || !experiment.baseModel.registryModelId) {
    issues.push({ code: "identity_mismatch", message: "Base model identity is incomplete" });
  }
  if (experiment.evaluation.independentEvaluatorDepartmentSlug !== "evaluation") {
    issues.push({
      code: "role_mismatch",
      field: "evaluation.independentEvaluatorDepartmentSlug",
      message: "Independent evaluation must remain with the evaluation department",
    });
  }

  const ok = issues.length === 0;
  return {
    ok,
    specVersion: DEPARTMENT_LEARNING_SPEC_VERSION,
    experimentId: experiment.experimentId,
    proposalFingerprint: fingerprint,
    status: ok ? "validated" : "rejected",
    issues,
    codePatch,
    checkedAt,
    trainingLaunched: false,
  };
}

export function assertValidatedLearningExperiment(
  input: ValidateLearningExperimentInput,
): { experiment: DepartmentLearningExperiment; validation: LearningValidationResult } {
  const validation = validateDepartmentLearningExperiment(input);
  const experiment = departmentLearningExperimentSchema.parse(input.experiment);
  if (!validation.ok) {
    throw new DomainError(
      "INVALID_STATE",
      validation.issues.map((issue) => issue.message).join("; ") || "Learning experiment rejected",
      422,
    );
  }
  return { experiment, validation };
}

function validatePermissions(
  actor: ValidateLearningExperimentInput["actor"],
  experiment: DepartmentLearningExperiment,
  issues: LearningValidationIssue[],
): void {
  if (actor.role === "system_administrator") {
    return;
  }
  if (actor.departmentSlug && actor.departmentSlug !== experiment.proposingDepartmentSlug) {
    issues.push({
      code: "permission",
      message: "Actor department does not match proposingDepartmentSlug",
    });
  }
  // Weight Optimization proposes methods/config/code; Math (or target) requests learning.
  if (
    experiment.proposingDepartmentSlug === LEARNING_ROLE_DEPARTMENTS.trainingMethodProposer
    || experiment.proposingDepartmentSlug === experiment.requestingDepartmentSlug
    || experiment.proposingDepartmentSlug === LEARNING_ROLE_DEPARTMENTS.codeImplementer
    || experiment.proposingDepartmentSlug === LEARNING_ROLE_DEPARTMENTS.provenanceReviewer
    || experiment.proposingDepartmentSlug === LEARNING_ROLE_DEPARTMENTS.independentEvaluator
  ) {
    return;
  }
  issues.push({
    code: "role_mismatch",
    field: "proposingDepartmentSlug",
    message: `Department ${experiment.proposingDepartmentSlug} cannot propose this learning experiment`,
  });
}

function validateDatasets(experiment: DepartmentLearningExperiment, issues: LearningValidationIssue[]): void {
  for (const [index, dataset] of experiment.datasets.entries()) {
    if (!dataset.contentHash || !dataset.source || !dataset.provenanceNote) {
      issues.push({
        code: "dataset_provenance",
        field: `datasets[${index}]`,
        message: "Dataset is missing provenance fields",
      });
    }
    const sealed = new Set(dataset.sealedEvaluationItemIds);
    const leaked = dataset.trainItemIds.filter((id) => sealed.has(id));
    if (leaked.length > 0) {
      issues.push({
        code: "evaluation_leakage",
        field: `datasets[${index}]`,
        message: `Training data intersects sealed evaluation items (${leaked.length} ids)`,
      });
    }
  }
}

function validateTrainingConfig(experiment: DepartmentLearningExperiment, issues: LearningValidationIssue[]): void {
  try {
    methodById(experiment.training.methodId);
  } catch {
    issues.push({
      code: "invalid_training_config",
      field: "training.methodId",
      message: `Unknown training method ${experiment.training.methodId}`,
    });
  }
  const { steps, learningRate, datasetSize, backend } = experiment.training;
  if (steps < 0 || steps > 200 || learningRate < 1e-6 || learningRate > 1e-3 || datasetSize < 1) {
    issues.push({
      code: "invalid_training_config",
      field: "training",
      message: "Training configuration is outside the local safety budget",
    });
  }
  // Existing colony LoRA executor is MLX/Apple and isolates production Qwen serving.
  // cuda-lora is allowed in the *spec* for future Blackwell work but cannot be executed yet.
  if (backend === "cuda-lora" && experiment.baseModel.alias.includes("qwen3:8b")) {
    // Spec may describe the intended backend; validation still passes if other checks succeed.
    // Execution remains forbidden by the workflow (trainingLaunched: false).
  }
  if (backend === "unspecified") {
    issues.push({
      code: "invalid_training_config",
      field: "training.backend",
      message: "Training backend must be specified (mlx-lm or cuda-lora)",
    });
  }
}

function validateApprovals(experiment: DepartmentLearningExperiment, issues: LearningValidationIssue[]): void {
  for (const approval of experiment.approvals) {
    if (approval.scope !== "promotion") {
      continue;
    }
    if (approval.departmentSlug === experiment.requestingDepartmentSlug) {
      issues.push({
        code: "self_approval",
        field: "approvals",
        message: "A department cannot approve promotion of its own trained adapter",
      });
    }
    if (approval.departmentSlug === experiment.proposingDepartmentSlug) {
      issues.push({
        code: "self_approval",
        field: "approvals",
        message: "The proposing department cannot approve promotion of its own proposal",
      });
    }
    if (approval.principalId === experiment.proposedByPrincipalId) {
      try {
        assertNotSelfDecision(
          { agentId: experiment.proposedByPrincipalId, principalId: experiment.proposedByPrincipalId },
          experiment.proposedByPrincipalId,
        );
      } catch (error) {
        issues.push({
          code: "self_approval",
          field: "approvals",
          message: error instanceof DomainError ? error.message : "Self-approval is forbidden",
        });
      }
    }
  }
}
