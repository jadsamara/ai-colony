import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  computePatchContentFingerprint,
  DEPARTMENT_LEARNING_SPEC_VERSION,
  fingerprintLearningExperiment,
  TRAINING_CODE_ALLOWLIST,
  validateDepartmentLearningExperiment,
  validateTrainingCodePatch,
  type DepartmentLearningExperiment,
  type TrainingCodePatch,
} from "@ai-colony/core";

const PROPOSER = "00000000-0000-4000-8000-000000000301";
const APPROVER = "00000000-0000-4000-8000-000000000302";

function basePatch(overrides: Partial<TrainingCodePatch> = {}): TrainingCodePatch {
  const files = [
    {
      path: "services/training/train_lora.py",
      action: "modify" as const,
      unifiedDiff: [
        "diff --git a/services/training/train_lora.py b/services/training/train_lora.py",
        "--- a/services/training/train_lora.py",
        "+++ b/services/training/train_lora.py",
        "@@ -1,3 +1,4 @@",
        "+from mlx import core as mx",
        " def main():",
        "     pass",
      ].join("\n"),
    },
  ];
  const draft = {
    baseRevision: "abc123def456",
    modifiedRevision: "pending",
    rationale: "Reduce LoRA rank for safer Qwen experiments on limited data.",
    expectedBenefit: "Lower overfitting risk on small arithmetic sets without changing serving.",
    files,
    proposedByDepartmentSlug: "weight-optimization" as const,
    ...overrides,
  };
  const withFiles = { ...draft, files: overrides.files ?? files };
  const modifiedRevision = overrides.modifiedRevision ?? computePatchContentFingerprint(withFiles);
  return { ...withFiles, modifiedRevision };
}

function mathExperiment(overrides: Partial<DepartmentLearningExperiment> = {}): DepartmentLearningExperiment {
  const codePatch = basePatch();
  const experiment: DepartmentLearningExperiment = {
    specVersion: DEPARTMENT_LEARNING_SPEC_VERSION,
    experimentId: randomUUID(),
    idempotencyKey: `c18b-math-${randomUUID()}`,
    status: "proposed",
    requestingDepartmentSlug: "math",
    targetDepartmentSlug: "math",
    proposingDepartmentSlug: "weight-optimization",
    proposedByPrincipalId: PROPOSER,
    learningObjective: "Improve affine and kinetic-energy skill accuracy after C1.8A baseline gaps.",
    targetedSkills: ["affine_solve", "kinetic_energy"],
    baseModel: {
      family: "qwen3",
      alias: "qwen3:8b",
      registryModelId: QWEN3_8B_MODEL_ID,
      digest: "sha256:deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef",
      weightsVersion: "base",
    },
    datasets: [
      {
        datasetId: "math-weakness-v1",
        contentHash: "a".repeat(64),
        source: "curated_arithmetic",
        provenanceNote: "Derived from non-sealed training split with explicit generator version.",
        trainItemIds: ["train-1", "train-2"],
        sealedEvaluationItemIds: ["eval-1", "eval-2"],
      },
    ],
    training: {
      methodId: "lora-supervised",
      learningRate: 1e-5,
      steps: 5,
      datasetSize: 25,
      seed: 7,
      target: "answer",
      backend: "cuda-lora",
    },
    codePatch,
    budgets: {
      maxGpuHours: 2,
      maxMemoryBytes: 48 * 1024 ** 3,
      maxWallClockMinutes: 120,
      maxExperiments: 3,
    },
    evaluation: {
      suiteId: "c18a-math-suite",
      suiteVersion: "c18a-math-v1",
      successCriteria: "Beat standard condition accuracy without sealed-set leakage or tool oracle use.",
      regressionChecks: ["few_shot_thinking_not_worse", "tool_assisted_not_worse"],
      independentEvaluatorDepartmentSlug: "evaluation",
    },
    artifactRefs: [],
    approvals: [],
    createdAt: "2026-11-11T18:00:00.000Z",
    ...overrides,
  };
  return experiment;
}

describe("C1.8B department learning foundation", () => {
  it("validates a Math learning proposal from Weight Optimization", () => {
    const experiment = mathExperiment();
    const result = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: PROPOSER,
        agentId: PROPOSER,
        departmentSlug: "weight-optimization",
        role: "department_agent",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("validated");
    expect(result.trainingLaunched).toBe(false);
    expect(result.proposalFingerprint).toBe(fingerprintLearningExperiment(experiment));
    expect(result.codePatch?.ok).toBe(true);
  });

  it("validates a Weight Optimization code-change proposal on allowlisted paths", () => {
    const patch = basePatch();
    const result = validateTrainingCodePatch(patch);
    expect(result.ok).toBe(true);
    expect(result.allowlistedPaths).toEqual(["services/training/train_lora.py"]);
    expect(TRAINING_CODE_ALLOWLIST).toContain("services/training/train_lora.py");
    expect(result.hooks.tests).toBe("skipped");
  });

  it("rejects unauthorized file modification", () => {
    const patch = basePatch({
      files: [
        {
          path: "apps/api/src/server.ts",
          action: "modify",
          unifiedDiff: "diff --git a/apps/api/src/server.ts b/apps/api/src/server.ts\n--- a/apps/api/src/server.ts\n+++ b/apps/api/src/server.ts\n@@ -1 +1 @@\n-a\n+b\n",
        },
      ],
    });
    const fixed = { ...patch, modifiedRevision: computePatchContentFingerprint(patch) };
    const result = validateTrainingCodePatch(fixed);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "path_not_allowlisted" || issue.code === "path_escape")).toBe(true);
  });

  it("rejects missing dataset provenance", () => {
    const experiment = mathExperiment({
      datasets: [
        {
          datasetId: "x",
          contentHash: "b".repeat(64),
          source: "",
          provenanceNote: "note",
          trainItemIds: ["t1"],
          sealedEvaluationItemIds: [],
        },
      ],
    });
    // Empty source fails schema first.
    const result = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: PROPOSER,
        agentId: PROPOSER,
        departmentSlug: "weight-optimization",
        role: "department_agent",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "invalid_spec" || issue.code === "dataset_provenance")).toBe(true);
  });

  it("rejects evaluation dataset leakage", () => {
    const experiment = mathExperiment({
      datasets: [
        {
          datasetId: "leaky",
          contentHash: "c".repeat(64),
          source: "curated_arithmetic",
          provenanceNote: "Intentionally overlaps sealed ids for the test.",
          trainItemIds: ["eval-9", "train-9"],
          sealedEvaluationItemIds: ["eval-9"],
        },
      ],
    });
    const result = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: PROPOSER,
        agentId: PROPOSER,
        departmentSlug: "weight-optimization",
        role: "department_agent",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "evaluation_leakage")).toBe(true);
  });

  it("rejects self-approval for promotion", () => {
    const experiment = mathExperiment({
      approvals: [
        {
          departmentSlug: "math",
          principalId: PROPOSER,
          decision: "approve",
          scope: "promotion",
          at: "2026-11-11T18:05:00.000Z",
        },
      ],
    });
    const result = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: PROPOSER,
        agentId: PROPOSER,
        departmentSlug: "weight-optimization",
        role: "department_agent",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "self_approval")).toBe(true);
  });

  it("rejects invalid training configuration", () => {
    const experiment = mathExperiment({
      training: {
        methodId: "lora-supervised",
        // Schema-valid but outside the local safety budget (lr must be ≤ 1e-3).
        learningRate: 0.5,
        steps: 50,
        datasetSize: 25,
        seed: 1,
        target: "answer",
        backend: "cuda-lora",
      },
    });
    const result = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: PROPOSER,
        agentId: PROPOSER,
        departmentSlug: "weight-optimization",
        role: "department_agent",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "invalid_training_config")).toBe(true);
  });

  it("produces reproducible proposal fingerprints", () => {
    const a = mathExperiment({ experimentId: "00000000-0000-4000-8000-000000000aaa", idempotencyKey: "stable-key-001" });
    const b = mathExperiment({ experimentId: "00000000-0000-4000-8000-000000000aaa", idempotencyKey: "stable-key-001" });
    expect(fingerprintLearningExperiment(a)).toBe(fingerprintLearningExperiment(b));
    const tweaked = mathExperiment({
      experimentId: "00000000-0000-4000-8000-000000000aaa",
      idempotencyKey: "stable-key-001",
      learningObjective: "A different objective that should change the fingerprint clearly.",
    });
    expect(fingerprintLearningExperiment(tweaked)).not.toBe(fingerprintLearningExperiment(a));
  });

  it("preserves existing model and evaluation identities in validated proposals", () => {
    const experiment = mathExperiment();
    const result = validateDepartmentLearningExperiment({
      experiment,
      actor: {
        principalId: APPROVER,
        agentId: null,
        departmentSlug: null,
        role: "system_administrator",
      },
    });
    expect(result.ok).toBe(true);
    expect(experiment.baseModel.registryModelId).toBe(QWEN3_8B_MODEL_ID);
    expect(experiment.baseModel.alias).toBe("qwen3:8b");
    expect(experiment.evaluation.suiteVersion).toBe("c18a-math-v1");
    expect(experiment.evaluation.independentEvaluatorDepartmentSlug).toBe("evaluation");
  });
});
