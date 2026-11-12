import { randomUUID } from "node:crypto";
import type { InferenceProvider } from "../inference/provider.js";
import {
  DEPARTMENT_LEARNING_SPEC_VERSION,
  LEARNING_ROLE_DEPARTMENTS,
  type DepartmentLearningExperiment,
  type LearningDepartmentSlug,
  type TrainingCodePatch,
} from "./department-learning-spec.js";
import { computePatchContentFingerprint } from "./training-code-patch.js";
import { hashAllowlistedTree } from "./patch-apply.js";

/**
 * Contribution sources are labeled so tests and operators never confuse
 * live department inference with an integration-boundary fixture.
 */
export type LearningContributionSource = "live_inference" | "integration_boundary";

export interface LearningContribution {
  departmentSlug: LearningDepartmentSlug;
  kind: "objective" | "strategy" | "provenance" | "code_patch";
  source: LearningContributionSource;
  summary: string;
  payload: Record<string, unknown>;
}

export interface AssembleLearningProposalInput {
  requestingDepartmentSlug: LearningDepartmentSlug;
  targetDepartmentSlug: LearningDepartmentSlug;
  proposedByPrincipalId: string;
  baseModel: DepartmentLearningExperiment["baseModel"];
  datasets: DepartmentLearningExperiment["datasets"];
  training: DepartmentLearningExperiment["training"];
  evaluation: DepartmentLearningExperiment["evaluation"];
  budgets: DepartmentLearningExperiment["budgets"];
  sourceRoot: string;
  /** Optional live inference; when absent, contributors must use integration_boundary. */
  inference?: InferenceProvider | null;
  contributions: {
    mathObjective: LearningContribution;
    weightOptimizationStrategy: LearningContribution;
    memoryProvenance: LearningContribution;
    engineeringPatch: LearningContribution;
  };
  approvals?: DepartmentLearningExperiment["approvals"];
  now?: () => Date;
}

export interface AssembledLearningProposal {
  experiment: DepartmentLearningExperiment;
  contributions: LearningContribution[];
  liveInferenceUsed: boolean;
  integrationBoundary: boolean;
}

/**
 * Narrow workflow that assembles a department learning experiment from
 * explicitly attributed department contributions, then leaves validation /
 * sandbox execution to the existing C1.8B/C1.8C services.
 */
export function assembleDepartmentLearningProposal(
  input: AssembleLearningProposalInput,
): AssembledLearningProposal {
  const contributions = [
    input.contributions.mathObjective,
    input.contributions.weightOptimizationStrategy,
    input.contributions.memoryProvenance,
    input.contributions.engineeringPatch,
  ];
  assertContribution(input.contributions.mathObjective, "math", "objective");
  assertContribution(
    input.contributions.weightOptimizationStrategy,
    LEARNING_ROLE_DEPARTMENTS.trainingMethodProposer,
    "strategy",
  );
  assertContribution(
    input.contributions.memoryProvenance,
    LEARNING_ROLE_DEPARTMENTS.provenanceReviewer,
    "provenance",
  );
  assertContribution(
    input.contributions.engineeringPatch,
    LEARNING_ROLE_DEPARTMENTS.codeImplementer,
    "code_patch",
  );

  const liveInferenceUsed = contributions.some((item) => item.source === "live_inference");
  const integrationBoundary = contributions.some((item) => item.source === "integration_boundary");
  if (liveInferenceUsed && !input.inference) {
    throw new Error(
      "live_inference contributions require an InferenceProvider; use integration_boundary when inference is unavailable",
    );
  }

  const patchPayload = input.contributions.engineeringPatch.payload.codePatch as TrainingCodePatch | undefined;
  if (!patchPayload) {
    throw new Error("Engineering contribution must include payload.codePatch");
  }
  const sourceTree = hashAllowlistedTree(input.sourceRoot);
  const files = patchPayload.files;
  const draft = {
    ...patchPayload,
    baseRevision: sourceTree.treeHash,
    proposedByDepartmentSlug: LEARNING_ROLE_DEPARTMENTS.codeImplementer,
    files,
  };
  const codePatch: TrainingCodePatch = {
    ...draft,
    modifiedRevision: computePatchContentFingerprint(draft),
  };

  const objective = String(
    input.contributions.mathObjective.payload.learningObjective
      ?? input.contributions.mathObjective.summary,
  );
  const skills = Array.isArray(input.contributions.mathObjective.payload.targetedSkills)
    ? (input.contributions.mathObjective.payload.targetedSkills as string[])
    : ["unspecified_skill"];

  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const experiment: DepartmentLearningExperiment = {
    specVersion: DEPARTMENT_LEARNING_SPEC_VERSION,
    experimentId: randomUUID(),
    idempotencyKey: `c18c-${input.requestingDepartmentSlug}-${randomUUID()}`,
    status: "proposed",
    requestingDepartmentSlug: input.requestingDepartmentSlug,
    targetDepartmentSlug: input.targetDepartmentSlug,
    proposingDepartmentSlug: LEARNING_ROLE_DEPARTMENTS.trainingMethodProposer,
    proposedByPrincipalId: input.proposedByPrincipalId,
    learningObjective: objective.slice(0, 2_000),
    targetedSkills: skills.slice(0, 32),
    baseModel: input.baseModel,
    datasets: input.datasets,
    training: input.training,
    codePatch,
    budgets: input.budgets,
    evaluation: input.evaluation,
    artifactRefs: [],
    approvals: input.approvals ?? [],
    createdAt,
  };

  return {
    experiment,
    contributions,
    liveInferenceUsed,
    integrationBoundary,
  };
}

/**
 * Helper for tests / offline wiring: build an integration-boundary contribution set
 * without pretending live department inference occurred.
 */
export function integrationBoundaryContributions(input: {
  learningObjective: string;
  targetedSkills: string[];
  strategySummary: string;
  provenanceNote: string;
  codePatch: Omit<TrainingCodePatch, "baseRevision" | "modifiedRevision"> & {
    baseRevision?: string;
    modifiedRevision?: string;
  };
}): AssembleLearningProposalInput["contributions"] {
  return {
    mathObjective: {
      departmentSlug: "math",
      kind: "objective",
      source: "integration_boundary",
      summary: input.learningObjective,
      payload: {
        learningObjective: input.learningObjective,
        targetedSkills: input.targetedSkills,
      },
    },
    weightOptimizationStrategy: {
      departmentSlug: "weight-optimization",
      kind: "strategy",
      source: "integration_boundary",
      summary: input.strategySummary,
      payload: { strategy: input.strategySummary },
    },
    memoryProvenance: {
      departmentSlug: "memory-and-forgetting",
      kind: "provenance",
      source: "integration_boundary",
      summary: input.provenanceNote,
      payload: { provenanceNote: input.provenanceNote },
    },
    engineeringPatch: {
      departmentSlug: "engineering",
      kind: "code_patch",
      source: "integration_boundary",
      summary: input.codePatch.rationale,
      payload: { codePatch: input.codePatch },
    },
  };
}

function assertContribution(
  contribution: LearningContribution,
  expectedSlug: LearningDepartmentSlug,
  kind: LearningContribution["kind"],
): void {
  if (contribution.departmentSlug !== expectedSlug) {
    throw new Error(`Expected ${expectedSlug} contribution, received ${contribution.departmentSlug}`);
  }
  if (contribution.kind !== kind) {
    throw new Error(`Expected contribution kind ${kind}, received ${contribution.kind}`);
  }
  if (contribution.source !== "live_inference" && contribution.source !== "integration_boundary") {
    throw new Error("Contribution source must be live_inference or integration_boundary");
  }
}
