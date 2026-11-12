import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DomainError } from "../errors/domain-error.js";
import {
  departmentLearningExperimentSchema,
  fingerprintLearningExperiment,
  type DepartmentLearningExperiment,
  type TrainingCodePatch,
} from "./department-learning-spec.js";
import { validateDepartmentLearningExperiment } from "./department-learning-validate.js";
import { hashAllowlistedTree, materializePatchedWorkspace } from "./patch-apply.js";
import { computePatchContentFingerprint, validateTrainingCodePatch } from "./training-code-patch.js";

export const TRAINING_SANDBOX_IMAGE = "ai-colony-training-sandbox:c18c" as const;
export const TRAINING_SANDBOX_SPEC_VERSION = "c18c-training-sandbox-v1" as const;

export interface SandboxLimits {
  memoryBytes: number;
  cpus: number;
  pids: number;
  timeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pids: 64,
  timeoutMs: 60_000,
};

export interface ContainerRunRequest {
  image: string;
  workspaceMount: string;
  scratchMount: string;
  evidenceMount: string;
  command: string[];
  limits: SandboxLimits;
  env: Record<string, string>;
}

export interface ContainerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  isolation: SandboxIsolationReport;
}

export interface SandboxIsolationReport {
  ok: boolean;
  engine: "docker" | "none";
  network: "none" | "unknown";
  readOnlyRoot: boolean;
  noGpu: boolean;
  noPrivileged: boolean;
  noDockerSocket: boolean;
  droppedAllCapabilities: boolean;
  noNewPrivileges: boolean;
  secretsScrubbed: boolean;
  issues: string[];
}

export interface TrainingSandboxRunner {
  probe(): Promise<{ available: boolean; detail: string }>;
  run(request: ContainerRunRequest): Promise<ContainerRunResult>;
}

export interface SandboxExecutionEvidence {
  specVersion: typeof TRAINING_SANDBOX_SPEC_VERSION;
  experimentId: string;
  proposalFingerprint: string;
  patchFingerprint: string;
  requestingDepartmentSlug: string;
  proposingDepartmentSlug: string;
  targetDepartmentSlug: string;
  originalTreeHash: string;
  modifiedTreeHash: string;
  originalFileHashes: Array<{ path: string; sha256: string }>;
  modifiedFileHashes: Array<{ path: string; sha256: string }>;
  patchRationale: string;
  datasetRefs: Array<{ datasetId: string; contentHash: string; source: string }>;
  validationOk: boolean;
  isolation: SandboxIsolationReport;
  syntaxExitCode: number | null;
  dryRunExitCode: number | null;
  logs: { stdout: string; stderr: string };
  durationMs: number;
  outcome: "passed" | "failed" | "rejected";
  failureCode: string | null;
  artifactHashes: Array<{ path: string; sha256: string }>;
  productionRepoModified: false;
  trainingLaunched: false;
  gpuUsed: false;
}

export interface ExecuteSandboxInput {
  experiment: unknown;
  actor: {
    principalId: string;
    agentId: string | null;
    departmentSlug: string | null;
    role: string;
  };
  sourceRoot: string;
  evidenceRoot: string;
  /** When set, reject if the experiment fingerprint differs (tamper detection). */
  expectedProposalFingerprint?: string;
  limits?: Partial<SandboxLimits>;
  runner?: TrainingSandboxRunner;
  now?: () => Date;
}

export interface ExecuteSandboxResult {
  ok: boolean;
  evidence: SandboxExecutionEvidence;
  workspacePreserved: false;
}

const FORBIDDEN_HOST_ENV = [
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "RABBITMQ_DEFAULT_PASS",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

/**
 * Deterministic sandbox execution for validated training-code patches.
 * Never mutates the production repository or Ollama volumes.
 */
export async function executeTrainingCodeSandbox(
  input: ExecuteSandboxInput,
): Promise<ExecuteSandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...input.limits };
  const runner = input.runner ?? createDockerSandboxRunner();
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();

  const parsed = departmentLearningExperimentSchema.safeParse(input.experiment);
  if (!parsed.success) {
    return rejectEarly(input, "invalid_spec", "Experiment specification is invalid", emptyIsolation(), checkedAt);
  }
  const experiment = parsed.data;
  if (!experiment.codePatch) {
    return rejectEarly(input, "missing_patch", "Sandbox execution requires a codePatch", emptyIsolation(), checkedAt, experiment);
  }

  const validation = validateDepartmentLearningExperiment({
    experiment,
    actor: input.actor,
    now: input.now,
  });
  const proposalFingerprint = fingerprintLearningExperiment(experiment);
  if (input.expectedProposalFingerprint && input.expectedProposalFingerprint !== proposalFingerprint) {
    return rejectEarly(
      input,
      "fingerprint_mismatch",
      "Experiment was modified after validation",
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }
  if (!validation.ok) {
    return rejectEarly(
      input,
      "validation_failed",
      validation.issues.map((issue) => issue.message).join("; "),
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }

  const approval = experiment.approvals.find(
    (item) => item.scope === "validation" && item.decision === "approve",
  );
  if (!approval) {
    return rejectEarly(
      input,
      "unapproved",
      "Sandbox execution requires an approved validation decision",
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }
  if (
    approval.departmentSlug === experiment.proposingDepartmentSlug
    || approval.principalId === experiment.proposedByPrincipalId
  ) {
    return rejectEarly(
      input,
      "self_approval",
      "Validation approval cannot come from the proposing department or principal",
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }

  const patchCheck = validateTrainingCodePatch(experiment.codePatch);
  if (!patchCheck.ok) {
    return rejectEarly(
      input,
      "patch_rejected",
      patchCheck.issues.map((issue) => issue.message).join("; "),
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }
  const expectedPatchFp = computePatchContentFingerprint(experiment.codePatch);
  if (experiment.codePatch.modifiedRevision !== expectedPatchFp) {
    return rejectEarly(
      input,
      "patch_tampered",
      "modifiedRevision no longer matches patch contents",
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }

  const probe = await runner.probe();
  if (!probe.available) {
    return rejectEarly(
      input,
      "sandbox_unavailable",
      `Sandbox isolation could not be established: ${probe.detail}`,
      {
        ...emptyIsolation(),
        issues: [probe.detail],
      },
      checkedAt,
      experiment,
    );
  }

  const preflightIsolation = evaluateSandboxIsolation({
    limits,
    env: sandboxEnv(),
  });
  if (!preflightIsolation.ok) {
    return rejectEarly(
      input,
      "isolation_failed",
      preflightIsolation.issues.join("; "),
      preflightIsolation,
      checkedAt,
      experiment,
    );
  }

  const sourceTree = hashAllowlistedTree(input.sourceRoot);
  if (experiment.codePatch.baseRevision !== sourceTree.treeHash) {
    return rejectEarly(
      input,
      "source_revision_mismatch",
      "Patch baseRevision does not match the current allowlisted source tree hash",
      emptyIsolation(),
      checkedAt,
      experiment,
    );
  }

  const evidenceDir = resolve(input.evidenceRoot, experiment.experimentId);
  mkdirSync(evidenceDir, { recursive: true });
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-colony-train-sandbox-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "ai-colony-train-scratch-"));

  let isolation = emptyIsolation();
  let syntaxExit: number | null = null;
  let dryRunExit: number | null = null;
  let logs = { stdout: "", stderr: "" };
  let durationMs = 0;
  let outcome: SandboxExecutionEvidence["outcome"] = "rejected";
  let failureCode: string | null = null;
  let originalTreeHash = sourceTree.treeHash;
  let modifiedTreeHash = sourceTree.treeHash;
  let originalFileHashes = sourceTree.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
  let modifiedFileHashes = originalFileHashes;
  const artifactHashes: Array<{ path: string; sha256: string }> = [];

  try {
    const applied = materializePatchedWorkspace({
      sourceRoot: input.sourceRoot,
      workspaceRoot,
      patch: experiment.codePatch,
    });
    originalTreeHash = applied.originalTreeHash;
    modifiedTreeHash = applied.modifiedTreeHash;
    originalFileHashes = applied.originalHashes.map((file) => ({ path: file.path, sha256: file.sha256 }));
    modifiedFileHashes = applied.modifiedHashes.map((file) => ({ path: file.path, sha256: file.sha256 }));

    // Stage dry-run job + tiny dataset inside scratch (writable), not production.
    const job = {
      backend: "cuda-lora",
      baseModelAlias: experiment.baseModel.alias.includes("qwen3") ? "qwen3:8b" : experiment.baseModel.alias,
      datasetId: experiment.datasets[0]?.datasetId,
      datasetContentHash: experiment.datasets[0]?.contentHash,
      datasetPath: "/scratch/dataset.jsonl",
      outputDir: "/scratch/output",
      seed: experiment.training.seed,
      loraRank: experiment.training.rank ?? 8,
      learningRate: experiment.training.learningRate,
      steps: experiment.training.steps,
      dryRun: true,
      downloadWeights: false,
      useGpu: false,
    };
    mkdirSync(join(scratchRoot, "output"), { recursive: true });
    mkdirSync(join(scratchRoot, "pycache"), { recursive: true });
    writeFileSync(
      join(scratchRoot, "dataset.jsonl"),
      `${JSON.stringify({ id: "smoke-1", prompt: "1+1", answer: "2" })}\n`,
      "utf8",
    );
    writeFileSync(join(scratchRoot, "job.json"), JSON.stringify(job, null, 2), "utf8");

    // Keep /workspace read-only: bytecode must land under /scratch, never __pycache__ in source.
    const syntaxCommand = buildSandboxSyntaxCommand(applied.touchedPaths);
    const syntaxResult = await runner.run({
      image: TRAINING_SANDBOX_IMAGE,
      workspaceMount: workspaceRoot,
      scratchMount: scratchRoot,
      evidenceMount: evidenceDir,
      command: syntaxCommand,
      limits,
      env: sandboxEnv(),
    });
    isolation = syntaxResult.isolation;
    logs = mergeLogs(logs, syntaxResult);
    durationMs += syntaxResult.durationMs;
    syntaxExit = syntaxResult.exitCode;

    if (!isolation.ok) {
      failureCode = "isolation_failed";
      outcome = "rejected";
    } else if (syntaxResult.timedOut) {
      failureCode = "timeout";
      outcome = "failed";
    } else if (syntaxResult.exitCode !== 0) {
      failureCode = "syntax_failed";
      outcome = "failed";
    } else {
      const dryRunCommand = [
        "python3",
        "/workspace/services/training/cuda/train_lora_cuda.py",
        "--job",
        "/scratch/job.json",
      ];
      const dryRunResult = await runner.run({
        image: TRAINING_SANDBOX_IMAGE,
        workspaceMount: workspaceRoot,
        scratchMount: scratchRoot,
        evidenceMount: evidenceDir,
        command: dryRunCommand,
        limits,
        env: sandboxEnv(),
      });
      isolation = dryRunResult.isolation;
      logs = mergeLogs(logs, dryRunResult);
      durationMs += dryRunResult.durationMs;
      dryRunExit = dryRunResult.exitCode;
      if (!isolation.ok) {
        failureCode = "isolation_failed";
        outcome = "rejected";
      } else if (dryRunResult.timedOut) {
        failureCode = "timeout";
        outcome = "failed";
      } else if (dryRunResult.exitCode !== 0) {
        failureCode = "dry_run_failed";
        outcome = "failed";
      } else {
        outcome = "passed";
        failureCode = null;
      }
    }

    // Preserve permitted evidence from scratch output.
    for (const name of ["result.json", "metrics.json", "config-manifest.json"]) {
      const abs = join(scratchRoot, "output", name);
      if (!existsSync(abs)) {
        continue;
      }
      const bytes = readFileSync(abs);
      const dest = join(evidenceDir, name);
      writeFileSync(dest, bytes);
      artifactHashes.push({ path: name, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  } catch (error) {
    failureCode = error instanceof DomainError ? error.code : "sandbox_error";
    outcome = "failed";
    logs = {
      stdout: logs.stdout,
      stderr: `${logs.stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
    };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }

  const evidence: SandboxExecutionEvidence = {
    specVersion: TRAINING_SANDBOX_SPEC_VERSION,
    experimentId: experiment.experimentId,
    proposalFingerprint,
    patchFingerprint: fingerprintPatch(experiment.codePatch),
    requestingDepartmentSlug: experiment.requestingDepartmentSlug,
    proposingDepartmentSlug: experiment.proposingDepartmentSlug,
    targetDepartmentSlug: experiment.targetDepartmentSlug,
    originalTreeHash,
    modifiedTreeHash,
    originalFileHashes,
    modifiedFileHashes,
    patchRationale: experiment.codePatch.rationale,
    datasetRefs: experiment.datasets.map((dataset) => ({
      datasetId: dataset.datasetId,
      contentHash: dataset.contentHash,
      source: dataset.source,
    })),
    validationOk: validation.ok,
    isolation,
    syntaxExitCode: syntaxExit,
    dryRunExitCode: dryRunExit,
    logs: {
      stdout: truncate(logs.stdout, 32_000),
      stderr: truncate(logs.stderr, 32_000),
    },
    durationMs,
    outcome,
    failureCode,
    artifactHashes,
    productionRepoModified: false,
    trainingLaunched: false,
    gpuUsed: false,
  };

  writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");

  return {
    ok: outcome === "passed",
    evidence,
    workspacePreserved: false,
  };
}

export function createDockerSandboxRunner(): TrainingSandboxRunner {
  return {
    async probe() {
      const version = await runHostCommand("docker", ["version", "--format", "{{.Server.Version}}"], 5_000);
      if (version.exitCode !== 0) {
        return { available: false, detail: version.stderr || version.stdout || "docker daemon unavailable" };
      }
      const image = await runHostCommand(
        "docker",
        ["image", "inspect", TRAINING_SANDBOX_IMAGE, "--format", "{{.Id}}"],
        5_000,
      );
      if (image.exitCode !== 0) {
        return {
          available: false,
          detail: `Required image ${TRAINING_SANDBOX_IMAGE} is not present locally (build deploy/Dockerfile.training-sandbox)`,
        };
      }
      return { available: true, detail: `docker ${version.stdout.trim()}` };
    },

    async run(request: ContainerRunRequest): Promise<ContainerRunResult> {
      const isolation = evaluateSandboxIsolation(request);
      if (!isolation.ok) {
        return {
          exitCode: 126,
          stdout: "",
          stderr: isolation.issues.join("; "),
          durationMs: 0,
          timedOut: false,
          isolation,
        };
      }

      const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--memory",
        String(request.limits.memoryBytes),
        "--memory-swap",
        String(request.limits.memoryBytes),
        "--cpus",
        String(request.limits.cpus),
        "--pids-limit",
        String(request.limits.pids),
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--user",
        "10001:10001",
        "--workdir",
        "/workspace",
        "-v",
        `${request.workspaceMount}:/workspace:ro`,
        "-v",
        `${request.scratchMount}:/scratch:rw`,
        "-v",
        `${request.evidenceMount}:/evidence:rw`,
      ];

      for (const [key, value] of Object.entries(request.env)) {
        args.push("-e", `${key}=${value}`);
      }
      // Explicitly refuse docker socket / GPU / privileged.
      if (args.includes("--privileged") || args.some((arg) => arg.includes("docker.sock")) || args.includes("--gpus")) {
        isolation.ok = false;
        isolation.issues.push("Refusing privileged, GPU, or docker.socket execution");
        return {
          exitCode: 126,
          stdout: "",
          stderr: isolation.issues.join("; "),
          durationMs: 0,
          timedOut: false,
          isolation,
        };
      }

      args.push(request.image, ...request.command);
      const started = Date.now();
      const result = await runHostCommand("docker", args, request.limits.timeoutMs, scrubbedHostEnv());
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        timedOut: result.timedOut,
        isolation,
      };
    },
  };
}

/**
 * Shared isolation gate used before any agent-modified code runs.
 * Rejects missing resource limits and secret-bearing environment variables.
 */
export function evaluateSandboxIsolation(input: {
  limits: SandboxLimits;
  env: Record<string, string>;
}): SandboxIsolationReport {
  const issues: string[] = [];
  if (input.limits.memoryBytes < 64 * 1024 * 1024) {
    issues.push("Memory limit too low to be enforceable");
  }
  if (input.limits.timeoutMs < 1_000) {
    issues.push("Execution timeout missing");
  }
  if (input.limits.pids < 8) {
    issues.push("Process limit missing");
  }
  if (input.limits.cpus <= 0) {
    issues.push("CPU limit missing");
  }
  for (const key of Object.keys(input.env)) {
    const upper = key.toUpperCase();
    for (const forbidden of FORBIDDEN_HOST_ENV) {
      if (upper === forbidden || upper.startsWith(`${forbidden}_`) || upper.startsWith("DATABASE_") || upper.includes("API_KEY")) {
        issues.push(`Sandbox env includes forbidden secret key ${key}`);
        break;
      }
    }
  }
  if (Object.keys(input.env).some((key) => key === "HTTP_PROXY" || key === "HTTPS_PROXY" || key === "ALL_PROXY")) {
    issues.push("Sandbox env must not enable outbound proxies");
  }
  return {
    ok: issues.length === 0,
    engine: "docker",
    network: "none",
    readOnlyRoot: true,
    noGpu: true,
    noPrivileged: true,
    noDockerSocket: true,
    droppedAllCapabilities: true,
    noNewPrivileges: true,
    secretsScrubbed: issues.every((issue) => !issue.includes("forbidden secret")),
    issues,
  };
}

/** Writable bytecode mirror inside the sandbox scratch mount (never under /workspace). */
export const SANDBOX_BYTECODE_DIR = "/scratch/pycache" as const;

/**
 * Python snippet that compiles sources with an explicit cfile under /scratch/pycache.
 * Avoids `python -m py_compile`, which writes `__pycache__` beside read-only sources.
 */
export const SANDBOX_SYNTAX_CHECK_SCRIPT = [
  "import pathlib, py_compile, sys",
  `root = pathlib.Path(${JSON.stringify(SANDBOX_BYTECODE_DIR)})`,
  "root.mkdir(parents=True, exist_ok=True)",
  "for src in sys.argv[1:]:",
  "    path = pathlib.Path(src)",
  "    cfile = root / f'{path.name}.pyc'",
  "    py_compile.compile(src, cfile=str(cfile), doraise=True)",
  "print('syntax_ok', len(sys.argv) - 1)",
].join("\n");

/**
 * Build the container command for syntax validation against a read-only /workspace.
 */
export function buildSandboxSyntaxCommand(touchedRepoPaths: string[]): string[] {
  return [
    "python3",
    "-c",
    SANDBOX_SYNTAX_CHECK_SCRIPT,
    ...touchedRepoPaths.map((path) => `/workspace/${path}`),
  ];
}

export function sandboxEnv(): Record<string, string> {
  return {
    // Imports must not attempt bytecode writes beside read-only sources.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    // Defense in depth if any import still materializes bytecode.
    PYTHONPYCACHEPREFIX: SANDBOX_BYTECODE_DIR,
    HOME: "/scratch",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

function scrubbedHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C",
  };
  // Docker needs access to its socket via the daemon client; do not forward DB/API secrets.
  if (process.env.DOCKER_HOST) {
    env.DOCKER_HOST = process.env.DOCKER_HOST;
  }
  return env;
}

function emptyIsolation(): SandboxIsolationReport {
  return {
    ok: false,
    engine: "none",
    network: "unknown",
    readOnlyRoot: false,
    noGpu: true,
    noPrivileged: true,
    noDockerSocket: true,
    droppedAllCapabilities: false,
    noNewPrivileges: false,
    secretsScrubbed: true,
    issues: ["isolation not established"],
  };
}

function rejectEarly(
  input: ExecuteSandboxInput,
  failureCode: string,
  message: string,
  isolation: SandboxIsolationReport,
  _checkedAt: string,
  experiment?: DepartmentLearningExperiment,
): ExecuteSandboxResult {
  const experimentId = experiment?.experimentId ?? randomUUID();
  const evidence: SandboxExecutionEvidence = {
    specVersion: TRAINING_SANDBOX_SPEC_VERSION,
    experimentId,
    proposalFingerprint: experiment ? fingerprintLearningExperiment(experiment) : "",
    patchFingerprint: experiment?.codePatch ? fingerprintPatch(experiment.codePatch) : "",
    requestingDepartmentSlug: experiment?.requestingDepartmentSlug ?? "unknown",
    proposingDepartmentSlug: experiment?.proposingDepartmentSlug ?? "unknown",
    targetDepartmentSlug: experiment?.targetDepartmentSlug ?? "unknown",
    originalTreeHash: "",
    modifiedTreeHash: "",
    originalFileHashes: [],
    modifiedFileHashes: [],
    patchRationale: experiment?.codePatch?.rationale ?? "",
    datasetRefs: experiment?.datasets.map((dataset) => ({
      datasetId: dataset.datasetId,
      contentHash: dataset.contentHash,
      source: dataset.source,
    })) ?? [],
    validationOk: false,
    isolation,
    syntaxExitCode: null,
    dryRunExitCode: null,
    logs: { stdout: "", stderr: message },
    durationMs: 0,
    outcome: "rejected",
    failureCode,
    artifactHashes: [],
    productionRepoModified: false,
    trainingLaunched: false,
    gpuUsed: false,
  };
  try {
    const dir = resolve(input.evidenceRoot, experimentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  } catch {
    // Evidence root may be unavailable in extreme rejection paths; still return the result.
  }
  return { ok: false, evidence, workspacePreserved: false };
}

function fingerprintPatch(patch: TrainingCodePatch): string {
  return createHash("sha256").update(JSON.stringify(patch)).digest("hex");
}

function mergeLogs(
  current: { stdout: string; stderr: string },
  next: { stdout: string; stderr: string },
): { stdout: string; stderr: string } {
  return {
    stdout: `${current.stdout}${current.stdout && next.stdout ? "\n" : ""}${next.stdout}`,
    stderr: `${current.stderr}${current.stderr && next.stderr ? "\n" : ""}${next.stderr}`,
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n…[truncated]`;
}

async function runHostCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = scrubbedHostEnv(),
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 127,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
  });
}
