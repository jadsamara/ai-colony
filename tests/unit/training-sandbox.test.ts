import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  DEPARTMENT_LEARNING_SPEC_VERSION,
  SANDBOX_BYTECODE_DIR,
  SANDBOX_SYNTAX_CHECK_SCRIPT,
  TRAINING_CODE_ALLOWLIST,
  assembleDepartmentLearningProposal,
  buildSandboxSyntaxCommand,
  computePatchContentFingerprint,
  evaluateSandboxIsolation,
  executeTrainingCodeSandbox,
  hashAllowlistedTree,
  integrationBoundaryContributions,
  materializePatchedWorkspace,
  sandboxEnv,
  validateTrainingCodePatch,
  type ContainerRunRequest,
  type ContainerRunResult,
  type DepartmentLearningExperiment,
  type TrainingCodePatch,
  type TrainingSandboxRunner,
} from "@ai-colony/core";

const PROPOSER = "00000000-0000-4000-8000-000000000401";
const APPROVER = "00000000-0000-4000-8000-000000000402";
const REPO_ROOT = join(process.cwd());

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function fixtureSourceRoot(): string {
  const root = tempDir("c18c-src-");
  for (const rel of TRAINING_CODE_ALLOWLIST) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) {
      continue;
    }
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  return root;
}

function makeCommentPatch(sourceRoot: string): TrainingCodePatch {
  const rel = "services/training/cuda/common_cuda.py";
  const original = readFileSync(join(sourceRoot, rel), "utf8");
  const lines = original.split("\n");
  const insertAt = 1; // after shebang / first line
  const updated = [
    ...lines.slice(0, insertAt),
    "# c18c-sandbox-smoke: deterministic marker",
    ...lines.slice(insertAt),
  ].join("\n");
  const oldLine = lines[insertAt] ?? "";
  const unifiedDiff = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${insertAt + 1},1 +${insertAt + 1},2 @@`,
    ` ${oldLine}`,
    `+# c18c-sandbox-smoke: deterministic marker`,
  ].join("\n");
  // Prefer a context-correct hunk using the first non-empty line near the top.
  const anchor = lines.findIndex((line, index) => index > 0 && line.startsWith('"""'));
  const at = anchor >= 0 ? anchor : 2;
  const context = lines[at] ?? '"""';
  const preciseDiff = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${at + 1},1 +${at + 1},2 @@`,
    ` ${context}`,
    `+# c18c-sandbox-smoke: deterministic marker`,
  ].join("\n");
  void updated;
  void unifiedDiff;
  const tree = hashAllowlistedTree(sourceRoot);
  const draft = {
    baseRevision: tree.treeHash,
    modifiedRevision: "pending",
    rationale: "Add a harmless marker comment for sandbox smoke testing.",
    expectedBenefit: "Proves Engineering can modify CUDA trainer helpers safely.",
    files: [
      {
        path: rel,
        action: "modify" as const,
        unifiedDiff: preciseDiff,
      },
    ],
    proposedByDepartmentSlug: "engineering" as const,
  };
  return { ...draft, modifiedRevision: computePatchContentFingerprint(draft) };
}

function approvedExperiment(
  sourceRoot: string,
  patch: TrainingCodePatch,
  overrides: Partial<DepartmentLearningExperiment> = {},
): DepartmentLearningExperiment {
  return {
    specVersion: DEPARTMENT_LEARNING_SPEC_VERSION,
    experimentId: randomUUID(),
    idempotencyKey: `c18c-${randomUUID()}`,
    status: "approved",
    requestingDepartmentSlug: "math",
    targetDepartmentSlug: "math",
    proposingDepartmentSlug: "weight-optimization",
    proposedByPrincipalId: PROPOSER,
    learningObjective: "Improve affine accuracy with a CUDA LoRA dry-run path.",
    targetedSkills: ["affine_solve"],
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
        contentHash: "b".repeat(64),
        source: "curated_arithmetic",
        provenanceNote: "Non-sealed training split reviewed by memory-and-forgetting.",
        trainItemIds: ["train-1"],
        sealedEvaluationItemIds: ["eval-1"],
      },
    ],
    training: {
      methodId: "lora-supervised",
      learningRate: 1e-5,
      steps: 5,
      datasetSize: 25,
      seed: 11,
      target: "answer",
      backend: "cuda-lora",
    },
    codePatch: patch,
    budgets: {
      maxGpuHours: 1,
      maxMemoryBytes: 16 * 1024 ** 3,
      maxWallClockMinutes: 30,
      maxExperiments: 2,
    },
    evaluation: {
      suiteId: "c18a-math-suite",
      suiteVersion: "c18a-math-v1",
      successCriteria: "Dry-run sandbox must pass without sealed-set leakage.",
      regressionChecks: ["no_promotion"],
      independentEvaluatorDepartmentSlug: "evaluation",
    },
    artifactRefs: [],
    approvals: [
      {
        departmentSlug: "evaluation",
        principalId: APPROVER,
        decision: "approve",
        scope: "validation",
        at: "2026-11-12T14:00:00.000Z",
      },
    ],
    createdAt: "2026-11-12T14:00:00.000Z",
    ...overrides,
  };
}

const ACTOR = {
  principalId: PROPOSER,
  agentId: PROPOSER,
  departmentSlug: "weight-optimization",
  role: "department_agent",
} as const;

function mockRunner(handlers?: {
  probe?: TrainingSandboxRunner["probe"];
  run?: (request: ContainerRunRequest, call: number) => Promise<ContainerRunResult> | ContainerRunResult;
}): TrainingSandboxRunner {
  let calls = 0;
  return {
    probe: handlers?.probe
      ?? (async () => ({ available: true, detail: "mock sandbox" })),
    async run(request) {
      calls += 1;
      if (handlers?.run) {
        return handlers.run(request, calls);
      }
      const isolation = evaluateSandboxIsolation(request);
      // Simulate py_compile / dry-run success and write dry-run artifacts on second call.
      if (request.command.some((arg) => arg.includes("train_lora_cuda.py"))) {
        const output = join(request.scratchMount, "output");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, dryRun: true }));
        writeFileSync(join(output, "metrics.json"), JSON.stringify({ status: "dry_run_ok" }));
        writeFileSync(join(output, "config-manifest.json"), JSON.stringify({ backend: "cuda-lora" }));
      }
      return {
        exitCode: 0,
        stdout: `mock-ok:${request.command.join(" ")}`,
        stderr: "",
        durationMs: 12,
        timedOut: false,
        isolation,
      };
    },
  };
}

describe("C1.8C isolated training-code sandbox", () => {
  it("executes a successful allowlisted patch through syntax + dry-run smoke tests", async () => {
    const sourceRoot = fixtureSourceRoot();
    const evidenceRoot = tempDir("c18c-evidence-");
    const patch = makeCommentPatch(sourceRoot);
    const experiment = approvedExperiment(sourceRoot, patch);
    const before = readFileSync(join(REPO_ROOT, "services/training/cuda/common_cuda.py"), "utf8");

    const result = await executeTrainingCodeSandbox({
      experiment,
      actor: ACTOR,
      sourceRoot,
      evidenceRoot,
      runner: mockRunner(),
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.outcome).toBe("passed");
    expect(result.evidence.productionRepoModified).toBe(false);
    expect(result.evidence.trainingLaunched).toBe(false);
    expect(result.evidence.gpuUsed).toBe(false);
    expect(result.evidence.syntaxExitCode).toBe(0);
    expect(result.evidence.dryRunExitCode).toBe(0);
    expect(result.evidence.artifactHashes.map((item) => item.path)).toEqual(
      expect.arrayContaining(["result.json", "metrics.json", "config-manifest.json"]),
    );
    expect(existsSync(join(evidenceRoot, experiment.experimentId, "evidence.json"))).toBe(true);
    expect(readFileSync(join(REPO_ROOT, "services/training/cuda/common_cuda.py"), "utf8")).toBe(before);
    expect(result.workspacePreserved).toBe(false);
  });

  it("rejects unauthorized paths", () => {
    const patch = {
      baseRevision: "x".repeat(64),
      modifiedRevision: "pending",
      rationale: "Attempt to modify production API code from a training proposal.",
      expectedBenefit: "Should be rejected by the allowlist before execution.",
      files: [
        {
          path: "apps/api/src/index.ts",
          action: "modify" as const,
          unifiedDiff: "diff --git a/apps/api/src/index.ts b/apps/api/src/index.ts\n--- a/apps/api/src/index.ts\n+++ b/apps/api/src/index.ts\n@@ -1,1 +1,2 @@\n keep\n+evil\n",
        },
      ],
      proposedByDepartmentSlug: "engineering" as const,
    };
    const withFp = { ...patch, modifiedRevision: computePatchContentFingerprint(patch) };
    const result = validateTrainingCodePatch(withFp);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "path_not_allowlisted" || issue.code === "path_escape")).toBe(true);
  });

  it("rejects symlink escapes in the source tree", () => {
    const sourceRoot = fixtureSourceRoot();
    const target = join(sourceRoot, "services/training/cuda/common_cuda.py");
    rmSync(target);
    symlinkSync("/etc/passwd", target);
    expect(() => hashAllowlistedTree(sourceRoot)).toThrow(/Symlink/);
  });

  it("rejects experiments modified after validation", async () => {
    const sourceRoot = fixtureSourceRoot();
    const evidenceRoot = tempDir("c18c-evidence-");
    const patch = makeCommentPatch(sourceRoot);
    const experiment = approvedExperiment(sourceRoot, patch);
    const result = await executeTrainingCodeSandbox({
      experiment,
      expectedProposalFingerprint: createHash("sha256").update("tampered").digest("hex"),
      actor: ACTOR,
      sourceRoot,
      evidenceRoot,
      runner: mockRunner(),
    });
    expect(result.ok).toBe(false);
    expect(result.evidence.failureCode).toBe("fingerprint_mismatch");
    expect(existsSync(join(evidenceRoot, result.evidence.experimentId, "evidence.json"))).toBe(true);
  });

  it("rejects unapproved proposals", async () => {
    const sourceRoot = fixtureSourceRoot();
    const evidenceRoot = tempDir("c18c-evidence-");
    const patch = makeCommentPatch(sourceRoot);
    const experiment = approvedExperiment(sourceRoot, patch, { approvals: [] });
    const result = await executeTrainingCodeSandbox({
      experiment,
      actor: ACTOR,
      sourceRoot,
      evidenceRoot,
      runner: mockRunner(),
    });
    expect(result.ok).toBe(false);
    expect(result.evidence.failureCode).toBe("unapproved");
  });

  it("rejects missing sandbox isolation", async () => {
    const sourceRoot = fixtureSourceRoot();
    const evidenceRoot = tempDir("c18c-evidence-");
    const patch = makeCommentPatch(sourceRoot);
    const experiment = approvedExperiment(sourceRoot, patch);
    const result = await executeTrainingCodeSandbox({
      experiment,
      actor: ACTOR,
      sourceRoot,
      evidenceRoot,
      runner: mockRunner({
        probe: async () => ({ available: false, detail: "docker daemon unavailable" }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.evidence.failureCode).toBe("sandbox_unavailable");
  });

  it("records timeout and resource-limit violations", async () => {
    const sourceRoot = fixtureSourceRoot();
    const evidenceRoot = tempDir("c18c-evidence-");
    const patch = makeCommentPatch(sourceRoot);
    const experiment = approvedExperiment(sourceRoot, patch);

    const timeoutResult = await executeTrainingCodeSandbox({
      experiment,
      actor: ACTOR,
      sourceRoot,
      evidenceRoot,
      runner: mockRunner({
        run: async (request) => ({
          exitCode: 137,
          stdout: "",
          stderr: "killed",
          durationMs: request.limits.timeoutMs,
          timedOut: true,
          isolation: evaluateSandboxIsolation(request),
        }),
      }),
    });
    expect(timeoutResult.ok).toBe(false);
    expect(timeoutResult.evidence.failureCode).toBe("timeout");

    const limit = evaluateSandboxIsolation({
      limits: { memoryBytes: 1024, cpus: 1, pids: 1, timeoutMs: 10 },
      env: {},
    });
    expect(limit.ok).toBe(false);
    expect(limit.issues.some((issue) => /limit/i.test(issue))).toBe(true);

    const limited = await executeTrainingCodeSandbox({
      experiment: approvedExperiment(sourceRoot, makeCommentPatch(sourceRoot)),
      actor: ACTOR,
      sourceRoot,
      evidenceRoot: tempDir("c18c-evidence-"),
      limits: { pids: 1, timeoutMs: 10, memoryBytes: 1024 },
      runner: mockRunner(),
    });
    expect(limited.ok).toBe(false);
    expect(limited.evidence.failureCode).toBe("isolation_failed");
  });

  it("rejects secret-bearing sandbox env and proxy configuration", () => {
    const secrets = evaluateSandboxIsolation({
      limits: { memoryBytes: 128 * 1024 * 1024, cpus: 1, pids: 32, timeoutMs: 5_000 },
      env: { DATABASE_URL: "postgres://secret", PATH: "/usr/bin" },
    });
    expect(secrets.ok).toBe(false);
    expect(secrets.issues.join("\n")).toContain("DATABASE_URL");

    const proxy = evaluateSandboxIsolation({
      limits: { memoryBytes: 128 * 1024 * 1024, cpus: 1, pids: 32, timeoutMs: 5_000 },
      env: { HTTPS_PROXY: "http://evil.example" },
    });
    expect(proxy.ok).toBe(false);
    expect(proxy.issues.join("\n")).toMatch(/prox/i);
  });

  it("assembles an integration-boundary department proposal without claiming live inference", () => {
    const sourceRoot = fixtureSourceRoot();
    const patch = makeCommentPatch(sourceRoot);
    const assembled = assembleDepartmentLearningProposal({
      requestingDepartmentSlug: "math",
      targetDepartmentSlug: "math",
      proposedByPrincipalId: PROPOSER,
      sourceRoot,
      baseModel: approvedExperiment(sourceRoot, patch).baseModel,
      datasets: approvedExperiment(sourceRoot, patch).datasets,
      training: approvedExperiment(sourceRoot, patch).training,
      evaluation: approvedExperiment(sourceRoot, patch).evaluation,
      budgets: approvedExperiment(sourceRoot, patch).budgets,
      contributions: integrationBoundaryContributions({
        learningObjective: "Close affine gaps observed in the C1.8A baseline.",
        targetedSkills: ["affine_solve"],
        strategySummary: "Use cuda-lora dry-run with rank 8 and low learning rate.",
        provenanceNote: "Training ids do not intersect sealed evaluation ids.",
        codePatch: patch,
      }),
    });
    expect(assembled.liveInferenceUsed).toBe(false);
    expect(assembled.integrationBoundary).toBe(true);
    expect(assembled.experiment.codePatch?.proposedByDepartmentSlug).toBe("engineering");
    expect(assembled.contributions.every((item) => item.source === "integration_boundary")).toBe(true);
  });

  it("applies a patch only inside the disposable workspace", () => {
    const sourceRoot = fixtureSourceRoot();
    const workspaceRoot = tempDir("c18c-workspace-");
    const patch = makeCommentPatch(sourceRoot);
    const applied = materializePatchedWorkspace({ sourceRoot, workspaceRoot, patch });
    const production = readFileSync(join(REPO_ROOT, "services/training/cuda/common_cuda.py"), "utf8");
    const isolated = readFileSync(join(workspaceRoot, "services/training/cuda/common_cuda.py"), "utf8");
    expect(isolated).toContain("c18c-sandbox-smoke");
    expect(production).not.toContain("c18c-sandbox-smoke");
    expect(applied.originalTreeHash).not.toBe(applied.modifiedTreeHash);
  });

  it("builds a syntax command that keeps bytecode under /scratch, not /workspace", () => {
    const command = buildSandboxSyntaxCommand(["services/training/cuda/common_cuda.py"]);
    expect(command[0]).toBe("python3");
    expect(command[1]).toBe("-c");
    expect(command.includes("-m")).toBe(false);
    expect(command[2]).toContain(SANDBOX_BYTECODE_DIR);
    expect(command[2]).toContain("cfile=");
    expect(command).toContain("/workspace/services/training/cuda/common_cuda.py");
    expect(sandboxEnv().PYTHONPYCACHEPREFIX).toBe(SANDBOX_BYTECODE_DIR);
    expect(sandboxEnv().PYTHONDONTWRITEBYTECODE).toBe("1");
  });

  it("compiles Python when the source directory is read-only without creating __pycache__", () => {
    const workspace = tempDir("c18c-ro-workspace-");
    const scratch = tempDir("c18c-ro-scratch-");
    const bytecodeDir = join(scratch, "pycache");
    mkdirSync(bytecodeDir, { recursive: true });
    const sourceFile = join(workspace, "sample.py");
    writeFileSync(sourceFile, "def ok():\n    return 1\n", "utf8");
    chmodSync(sourceFile, 0o444);
    chmodSync(workspace, 0o555);

    const script = SANDBOX_SYNTAX_CHECK_SCRIPT.replaceAll(SANDBOX_BYTECODE_DIR, bytecodeDir);
    const result = spawnSync("python3", ["-c", script, sourceFile], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("syntax_ok");
    expect(existsSync(join(workspace, "__pycache__"))).toBe(false);
    expect(existsSync(join(bytecodeDir, "sample.py.pyc"))).toBe(true);

    chmodSync(workspace, 0o755);
    chmodSync(sourceFile, 0o644);
  });

  it("runs syntax then dry-run with a read-only workspace mount contract", async () => {
    const sourceRoot = fixtureSourceRoot();
    const evidenceRoot = tempDir("c18c-evidence-");
    const patch = makeCommentPatch(sourceRoot);
    const experiment = approvedExperiment(sourceRoot, patch);
    const requests: ContainerRunRequest[] = [];

    const result = await executeTrainingCodeSandbox({
      experiment,
      actor: ACTOR,
      sourceRoot,
      evidenceRoot,
      runner: mockRunner({
        run: async (request) => {
          requests.push(request);
          const isolation = evaluateSandboxIsolation(request);
          if (request.command.some((arg) => arg.includes("train_lora_cuda.py"))) {
            const output = join(request.scratchMount, "output");
            mkdirSync(output, { recursive: true });
            writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, dryRun: true }));
            writeFileSync(join(output, "metrics.json"), JSON.stringify({ status: "dry_run_ok" }));
            writeFileSync(join(output, "config-manifest.json"), JSON.stringify({ backend: "cuda-lora" }));
          }
          return {
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            durationMs: 3,
            timedOut: false,
            isolation,
          };
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.command[1]).toBe("-c");
    expect(requests[0]?.command.includes("-m")).toBe(false);
    expect(requests[0]?.env.PYTHONPYCACHEPREFIX).toBe(SANDBOX_BYTECODE_DIR);
    expect(requests[1]?.command.some((arg) => arg.includes("train_lora_cuda.py"))).toBe(true);
    expect(result.evidence.syntaxExitCode).toBe(0);
    expect(result.evidence.dryRunExitCode).toBe(0);
  });
});
