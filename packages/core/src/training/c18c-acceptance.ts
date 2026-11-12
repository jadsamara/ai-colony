import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  DEPARTMENT_LEARNING_SPEC_VERSION,
  fingerprintLearningExperiment,
  type DepartmentLearningExperiment,
  type TrainingCodePatch,
} from "./department-learning-spec.js";
import { validateDepartmentLearningExperiment } from "./department-learning-validate.js";
import { hashAllowlistedTree } from "./patch-apply.js";
import { computePatchContentFingerprint, validateTrainingCodePatch } from "./training-code-patch.js";
import {
  TRAINING_SANDBOX_IMAGE,
  TRAINING_SANDBOX_SPEC_VERSION,
  createDockerSandboxRunner,
  executeTrainingCodeSandbox,
  type ExecuteSandboxResult,
  type TrainingSandboxRunner,
} from "./training-sandbox.js";

export const C18C_ACCEPTANCE_MARKER = "# c18c-acceptance: deterministic marker" as const;
export const C18C_ACCEPTANCE_EXPERIMENT_ID = "00000000-0000-4000-8000-000000000c18" as const;
export const C18C_ACCEPTANCE_PROPOSER_ID = "00000000-0000-4000-8000-000000000301" as const;
export const C18C_ACCEPTANCE_APPROVER_ID = "00000000-0000-4000-8000-000000000302" as const;
export const C18C_ACCEPTANCE_PATCH_PATH = "services/training/cuda/common_cuda.py" as const;

export interface C18cAcceptanceOptions {
  repoRoot: string;
  evidenceRoot?: string;
  reportPath?: string;
  /** Build `ai-colony-training-sandbox:c18c` when missing. Default true. */
  buildImageIfMissing?: boolean;
  /** Injectable for unit tests. Defaults to the real Docker runner. */
  runner?: TrainingSandboxRunner;
  /** Injectable image ensure hook for unit tests. */
  ensureImage?: (input: { repoRoot: string; buildIfMissing: boolean }) => Promise<EnsureSandboxImageResult>;
  now?: () => Date;
}

export interface EnsureSandboxImageResult {
  available: boolean;
  built: boolean;
  detail: string;
}

export interface C18cAcceptanceCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface C18cAcceptanceReport {
  specVersion: "c18c-acceptance-v1";
  ok: boolean;
  /** Always false in checked-in docs/agent claims; set true only by a successful operator run on a host. */
  operatorHost: string;
  dockerIsolationVerified: boolean;
  productionRepoUnchanged: boolean;
  workspacePreserved: false;
  trainingLaunched: false;
  gpuUsed: false;
  databaseAccessed: false;
  ollamaModified: false;
  modelsDownloaded: false;
  image: {
    name: typeof TRAINING_SANDBOX_IMAGE;
    available: boolean;
    builtDuringRun: boolean;
    detail: string;
  };
  validation: {
    ok: boolean;
    proposalFingerprint: string | null;
    issueCodes: string[];
  };
  sandbox: {
    outcome: ExecuteSandboxResult["evidence"]["outcome"] | null;
    failureCode: string | null;
    syntaxExitCode: number | null;
    dryRunExitCode: number | null;
    isolationOk: boolean;
    evidencePath: string | null;
  };
  productionHashes: {
    beforeTreeHash: string;
    afterTreeHash: string;
  };
  checks: C18cAcceptanceCheck[];
  experimentId: string;
  createdAt: string;
  notes: string[];
}

/**
 * Ensure the restricted training-sandbox image exists locally.
 * May require outbound network once to fetch the base Python image during build.
 * Agent-modified code still runs later with `--network none`.
 */
export async function ensureTrainingSandboxImage(input: {
  repoRoot: string;
  buildIfMissing?: boolean;
}): Promise<EnsureSandboxImageResult> {
  const buildIfMissing = input.buildIfMissing ?? true;
  const inspect = await runCommand("docker", ["image", "inspect", TRAINING_SANDBOX_IMAGE, "--format", "{{.Id}}"], 10_000);
  if (inspect.exitCode === 0) {
    return { available: true, built: false, detail: `image present ${inspect.stdout.trim()}` };
  }
  if (!buildIfMissing) {
    return {
      available: false,
      built: false,
      detail: `Required image ${TRAINING_SANDBOX_IMAGE} is missing and buildImageIfMissing=false`,
    };
  }
  const dockerfile = resolve(input.repoRoot, "deploy/Dockerfile.training-sandbox");
  if (!existsSync(dockerfile)) {
    return { available: false, built: false, detail: `Dockerfile missing at ${dockerfile}` };
  }
  const build = await runCommand(
    "docker",
    ["build", "-f", dockerfile, "-t", TRAINING_SANDBOX_IMAGE, resolve(input.repoRoot)],
    10 * 60_000,
  );
  if (build.exitCode !== 0) {
    return {
      available: false,
      built: false,
      detail: `docker build failed: ${(build.stderr || build.stdout).slice(-2_000)}`,
    };
  }
  return { available: true, built: true, detail: `built ${TRAINING_SANDBOX_IMAGE}` };
}

/**
 * Build the deterministic approved C1.8C acceptance experiment against the live allowlisted tree.
 */
export function buildC18cAcceptanceExperiment(repoRoot: string, now = () => new Date()): {
  experiment: DepartmentLearningExperiment;
  patch: TrainingCodePatch;
  sourceTreeHash: string;
} {
  const sourceTree = hashAllowlistedTree(repoRoot);
  const original = readFileSync(resolve(repoRoot, C18C_ACCEPTANCE_PATCH_PATH), "utf8");
  if (original.includes(C18C_ACCEPTANCE_MARKER)) {
    throw new Error(
      `${C18C_ACCEPTANCE_PATCH_PATH} already contains the acceptance marker; refusing to patch a dirty production tree`,
    );
  }
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  const at = Math.max(
    1,
    lines.findIndex((line, index) => index > 0 && line.startsWith('"""')),
  );
  const context = lines[at] ?? '"""';
  const unifiedDiff = [
    `diff --git a/${C18C_ACCEPTANCE_PATCH_PATH} b/${C18C_ACCEPTANCE_PATCH_PATH}`,
    `--- a/${C18C_ACCEPTANCE_PATCH_PATH}`,
    `+++ b/${C18C_ACCEPTANCE_PATCH_PATH}`,
    `@@ -${at + 1},1 +${at + 1},2 @@`,
    ` ${context}`,
    `+${C18C_ACCEPTANCE_MARKER}`,
  ].join("\n");

  const draft = {
    baseRevision: sourceTree.treeHash,
    modifiedRevision: "pending",
    rationale: "C1.8C GPU VM acceptance: harmless marker in CUDA common helpers.",
    expectedBenefit: "Proves isolated syntax + dry-run without changing production files.",
    files: [
      {
        path: C18C_ACCEPTANCE_PATCH_PATH,
        action: "modify" as const,
        unifiedDiff,
      },
    ],
    proposedByDepartmentSlug: "engineering" as const,
  };
  const patch: TrainingCodePatch = {
    ...draft,
    modifiedRevision: computePatchContentFingerprint(draft),
  };

  const createdAt = now().toISOString();
  const experiment: DepartmentLearningExperiment = {
    specVersion: DEPARTMENT_LEARNING_SPEC_VERSION,
    experimentId: C18C_ACCEPTANCE_EXPERIMENT_ID,
    idempotencyKey: "c18c-acceptance-deterministic-v1",
    status: "approved",
    requestingDepartmentSlug: "math",
    targetDepartmentSlug: "math",
    proposingDepartmentSlug: "weight-optimization",
    proposedByPrincipalId: C18C_ACCEPTANCE_PROPOSER_ID,
    learningObjective: "Acceptance-test isolated CUDA trainer dry-run for Math self-training foundation.",
    targetedSkills: ["affine_solve"],
    baseModel: {
      family: "qwen3",
      alias: "qwen3:8b",
      registryModelId: QWEN3_8B_MODEL_ID,
      digest: "sha256:c18c-acceptance-digest-not-a-live-weight-hash-0000000000000001",
      weightsVersion: "base",
    },
    datasets: [
      {
        datasetId: "c18c-acceptance-smoke",
        contentHash: createHash("sha256").update("c18c-acceptance-smoke-v1").digest("hex"),
        source: "acceptance_fixture",
        provenanceNote: "Synthetic smoke row for dry-run only; not used for model training.",
        trainItemIds: ["accept-train-1"],
        sealedEvaluationItemIds: ["accept-eval-1"],
      },
    ],
    training: {
      methodId: "lora-supervised",
      learningRate: 1e-5,
      steps: 5,
      datasetSize: 1,
      seed: 18,
      rank: 8,
      target: "answer",
      backend: "cuda-lora",
    },
    codePatch: patch,
    budgets: {
      maxGpuHours: 0,
      maxMemoryBytes: 512 * 1024 * 1024,
      maxWallClockMinutes: 5,
      maxExperiments: 1,
    },
    evaluation: {
      suiteId: "c18a-math-suite",
      suiteVersion: "c18a-math-v1",
      successCriteria: "Sandbox syntax + dry-run pass; production tree unchanged; no GPU training.",
      regressionChecks: ["production_tree_unchanged", "no_gpu", "no_ollama_mutation"],
      independentEvaluatorDepartmentSlug: "evaluation",
    },
    artifactRefs: [],
    approvals: [
      {
        departmentSlug: "evaluation",
        principalId: C18C_ACCEPTANCE_APPROVER_ID,
        decision: "approve",
        scope: "validation",
        at: createdAt,
      },
    ],
    createdAt,
  };

  return { experiment, patch, sourceTreeHash: sourceTree.treeHash };
}

/**
 * Operator-facing C1.8C acceptance: validate → sandbox → verify production unchanged.
 * Does not open PostgreSQL, touch Ollama, download weights, or start GPU training.
 */
export async function runC18cSandboxAcceptance(options: C18cAcceptanceOptions): Promise<C18cAcceptanceReport> {
  const repoRoot = resolve(options.repoRoot);
  const evidenceRoot = resolve(options.evidenceRoot ?? join(repoRoot, "tmp/c18c-acceptance/evidence"));
  const reportPath = resolve(
    options.reportPath ?? join(repoRoot, "tmp/c18c-acceptance/acceptance-report.json"),
  );
  const buildIfMissing = options.buildImageIfMissing ?? true;
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const checks: C18cAcceptanceCheck[] = [];
  const notes: string[] = [
    "This report is produced by the acceptance command on the host that executed it.",
    "Cursor/local agents cannot access the GPU VM; treat GPU verification as pending until this command is run over SSH.",
  ];

  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(resolve(reportPath, ".."), { recursive: true });

  const beforeTree = hashAllowlistedTree(repoRoot);
  const ensure = options.ensureImage
    ?? ((input: { repoRoot: string; buildIfMissing: boolean }) => ensureTrainingSandboxImage(input));
  const image = await ensure({ repoRoot, buildIfMissing });
  checks.push({
    id: "sandbox_image",
    ok: image.available,
    detail: image.detail,
  });

  const runner = options.runner ?? createDockerSandboxRunner();
  const probe = await runner.probe();
  checks.push({
    id: "docker_isolation_probe",
    ok: probe.available,
    detail: probe.detail,
  });

  if (!image.available || !probe.available) {
    const report = baseReport({
      ok: false,
      createdAt,
      image,
      beforeTreeHash: beforeTree.treeHash,
      afterTreeHash: beforeTree.treeHash,
      checks,
      notes: [
        ...notes,
        "Fail closed: Docker isolation or sandbox image could not be established.",
      ],
      validation: { ok: false, proposalFingerprint: null, issueCodes: ["sandbox_unavailable"] },
      sandbox: {
        outcome: "rejected",
        failureCode: "sandbox_unavailable",
        syntaxExitCode: null,
        dryRunExitCode: null,
        isolationOk: false,
        evidencePath: null,
      },
    });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const { experiment, patch } = buildC18cAcceptanceExperiment(repoRoot, now);
  const patchValidation = validateTrainingCodePatch(patch);
  checks.push({
    id: "patch_validation",
    ok: patchValidation.ok,
    detail: patchValidation.ok
      ? `allowlisted ${patchValidation.allowlistedPaths.join(",")}`
      : patchValidation.issues.map((issue) => issue.message).join("; "),
  });

  const validation = validateDepartmentLearningExperiment({
    experiment,
    actor: {
      principalId: C18C_ACCEPTANCE_PROPOSER_ID,
      agentId: C18C_ACCEPTANCE_PROPOSER_ID,
      departmentSlug: "weight-optimization",
      role: "department_agent",
    },
    now,
  });
  const proposalFingerprint = fingerprintLearningExperiment(experiment);
  checks.push({
    id: "experiment_validation",
    ok: validation.ok,
    detail: validation.ok
      ? `fingerprint ${proposalFingerprint}`
      : validation.issues.map((issue) => `${issue.code}:${issue.message}`).join("; "),
  });

  // File-based audit trail (no PostgreSQL).
  const auditPath = join(evidenceRoot, experiment.experimentId, "validation-audit.json");
  mkdirSync(resolve(auditPath, ".."), { recursive: true });
  writeFileSync(
    auditPath,
    `${JSON.stringify(
      {
        eventType: validation.ok ? "learning.experiment_validated" : "learning.experiment_rejected",
        targetType: "department_learning_experiment",
        targetId: experiment.experimentId,
        proposalFingerprint,
        trainingLaunched: false,
        databaseAccessed: false,
        at: createdAt,
        issueCodes: validation.issues.map((issue) => issue.code),
      },
      null,
      2,
    )}\n`,
  );

  if (!patchValidation.ok || !validation.ok) {
    const afterTree = hashAllowlistedTree(repoRoot);
    const report = baseReport({
      ok: false,
      createdAt,
      image,
      beforeTreeHash: beforeTree.treeHash,
      afterTreeHash: afterTree.treeHash,
      checks,
      notes,
      validation: {
        ok: validation.ok,
        proposalFingerprint,
        issueCodes: validation.issues.map((issue) => issue.code),
      },
      sandbox: {
        outcome: "rejected",
        failureCode: "validation_failed",
        syntaxExitCode: null,
        dryRunExitCode: null,
        isolationOk: false,
        evidencePath: auditPath,
      },
    });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const sandbox = await executeTrainingCodeSandbox({
    experiment,
    expectedProposalFingerprint: proposalFingerprint,
    actor: {
      principalId: C18C_ACCEPTANCE_PROPOSER_ID,
      agentId: C18C_ACCEPTANCE_PROPOSER_ID,
      departmentSlug: "weight-optimization",
      role: "department_agent",
    },
    sourceRoot: repoRoot,
    evidenceRoot,
    runner,
    now,
  });

  const evidencePath = join(evidenceRoot, experiment.experimentId, "evidence.json");
  const afterTree = hashAllowlistedTree(repoRoot);
  const productionUnchanged = afterTree.treeHash === beforeTree.treeHash
    && !readFileSync(resolve(repoRoot, C18C_ACCEPTANCE_PATCH_PATH), "utf8").includes(C18C_ACCEPTANCE_MARKER);

  checks.push({
    id: "sandbox_execution",
    ok: sandbox.ok && sandbox.evidence.outcome === "passed",
    detail: sandbox.ok
      ? `syntax=${sandbox.evidence.syntaxExitCode} dryRun=${sandbox.evidence.dryRunExitCode}`
      : `${sandbox.evidence.failureCode}: ${sandbox.evidence.logs.stderr.slice(0, 500)}`,
  });
  checks.push({
    id: "isolation",
    ok: sandbox.evidence.isolation.ok
      && sandbox.evidence.isolation.network === "none"
      && sandbox.evidence.isolation.noGpu
      && sandbox.evidence.isolation.noDockerSocket,
    detail: sandbox.evidence.isolation.ok
      ? "network=none, noGpu, noDockerSocket, secretsScrubbed"
      : sandbox.evidence.isolation.issues.join("; "),
  });
  checks.push({
    id: "cleanup",
    ok: sandbox.workspacePreserved === false,
    detail: "disposable workspace deleted after evidence capture",
  });
  checks.push({
    id: "evidence_preserved",
    ok: existsSync(evidencePath),
    detail: existsSync(evidencePath) ? evidencePath : "evidence.json missing",
  });
  checks.push({
    id: "production_unchanged",
    ok: productionUnchanged,
    detail: productionUnchanged
      ? `treeHash ${afterTree.treeHash}`
      : "production allowlisted training files changed during acceptance",
  });
  checks.push({
    id: "no_gpu_training",
    ok: sandbox.evidence.gpuUsed === false && sandbox.evidence.trainingLaunched === false,
    detail: "gpuUsed=false trainingLaunched=false",
  });

  const ok = checks.every((check) => check.ok);
  const report = baseReport({
    ok,
    createdAt,
    image,
    beforeTreeHash: beforeTree.treeHash,
    afterTreeHash: afterTree.treeHash,
    checks,
    notes,
    validation: {
      ok: validation.ok,
      proposalFingerprint,
      issueCodes: validation.issues.map((issue) => issue.code),
    },
    sandbox: {
      outcome: sandbox.evidence.outcome,
      failureCode: sandbox.evidence.failureCode,
      syntaxExitCode: sandbox.evidence.syntaxExitCode,
      dryRunExitCode: sandbox.evidence.dryRunExitCode,
      isolationOk: sandbox.evidence.isolation.ok,
      evidencePath: existsSync(evidencePath) ? evidencePath : null,
    },
    productionRepoUnchanged: productionUnchanged,
    dockerIsolationVerified: sandbox.evidence.isolation.ok && probe.available,
  });

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(evidenceRoot, experiment.experimentId, "sandbox-audit.json"),
    `${JSON.stringify(
      {
        eventType: sandbox.ok ? "learning.sandbox_passed" : "learning.sandbox_failed",
        targetId: experiment.experimentId,
        outcome: sandbox.evidence.outcome,
        failureCode: sandbox.evidence.failureCode,
        trainingLaunched: false,
        gpuUsed: false,
        databaseAccessed: false,
        ollamaModified: false,
        at: createdAt,
      },
      null,
      2,
    )}\n`,
  );
  return report;
}

function baseReport(input: {
  ok: boolean;
  createdAt: string;
  image: EnsureSandboxImageResult;
  beforeTreeHash: string;
  afterTreeHash: string;
  checks: C18cAcceptanceCheck[];
  notes: string[];
  validation: C18cAcceptanceReport["validation"];
  sandbox: C18cAcceptanceReport["sandbox"];
  productionRepoUnchanged?: boolean;
  dockerIsolationVerified?: boolean;
}): C18cAcceptanceReport {
  return {
    specVersion: "c18c-acceptance-v1",
    ok: input.ok,
    operatorHost: hostname(),
    dockerIsolationVerified: input.dockerIsolationVerified ?? false,
    productionRepoUnchanged: input.productionRepoUnchanged
      ?? input.beforeTreeHash === input.afterTreeHash,
    workspacePreserved: false,
    trainingLaunched: false,
    gpuUsed: false,
    databaseAccessed: false,
    ollamaModified: false,
    modelsDownloaded: false,
    image: {
      name: TRAINING_SANDBOX_IMAGE,
      available: input.image.available,
      builtDuringRun: input.image.built,
      detail: input.image.detail,
    },
    validation: input.validation,
    sandbox: input.sandbox,
    productionHashes: {
      beforeTreeHash: input.beforeTreeHash,
      afterTreeHash: input.afterTreeHash,
    },
    checks: input.checks,
    experimentId: C18C_ACCEPTANCE_EXPERIMENT_ID,
    createdAt: input.createdAt,
    notes: input.notes,
  };
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      shell: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        DOCKER_HOST: process.env.DOCKER_HOST,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

// Keep sandbox spec version referenced for report consumers.
void TRAINING_SANDBOX_SPEC_VERSION;
