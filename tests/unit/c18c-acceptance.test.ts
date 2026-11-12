import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  C18C_ACCEPTANCE_MARKER,
  C18C_ACCEPTANCE_PATCH_PATH,
  TRAINING_CODE_ALLOWLIST,
  buildC18cAcceptanceExperiment,
  evaluateSandboxIsolation,
  runC18cSandboxAcceptance,
  type ContainerRunRequest,
  type TrainingSandboxRunner,
} from "@ai-colony/core";
import { cpSync, existsSync } from "node:fs";

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

function fixtureRepo(): string {
  const root = tempDir("c18c-accept-src-");
  for (const rel of TRAINING_CODE_ALLOWLIST) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) {
      continue;
    }
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  // Minimal dockerfile presence for ensureImage paths that check the file.
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy/Dockerfile.training-sandbox"), "FROM python:3.11-slim-bookworm\n");
  return root;
}

function mockRunner(ok = true): TrainingSandboxRunner {
  return {
    async probe() {
      return ok
        ? { available: true, detail: "mock docker" }
        : { available: false, detail: "docker daemon unavailable" };
    },
    async run(request: ContainerRunRequest) {
      const isolation = evaluateSandboxIsolation(request);
      if (request.command.some((arg) => arg.includes("train_lora_cuda.py"))) {
        const output = join(request.scratchMount, "output");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, dryRun: true }));
        writeFileSync(join(output, "metrics.json"), JSON.stringify({ status: "dry_run_ok" }));
        writeFileSync(join(output, "config-manifest.json"), JSON.stringify({ backend: "cuda-lora" }));
      }
      return {
        exitCode: ok ? 0 : 1,
        stdout: "mock",
        stderr: ok ? "" : "failed",
        durationMs: 5,
        timedOut: false,
        isolation,
      };
    },
  };
}

describe("C1.8C GPU VM acceptance harness", () => {
  it("builds a deterministic approved acceptance experiment against the allowlisted tree", () => {
    const root = fixtureRepo();
    const a = buildC18cAcceptanceExperiment(root, () => new Date("2026-11-12T15:00:00.000Z"));
    const b = buildC18cAcceptanceExperiment(root, () => new Date("2026-11-12T15:00:00.000Z"));
    expect(a.experiment.experimentId).toBe(b.experiment.experimentId);
    expect(a.patch.modifiedRevision).toBe(b.patch.modifiedRevision);
    expect(a.patch.files[0]?.unifiedDiff).toContain(C18C_ACCEPTANCE_MARKER);
    expect(a.experiment.approvals[0]?.scope).toBe("validation");
  });

  it("passes acceptance with an injectable sandbox runner and leaves production files unchanged", async () => {
    const root = fixtureRepo();
    const evidenceRoot = tempDir("c18c-accept-evidence-");
    const reportPath = join(tempDir("c18c-accept-report-"), "acceptance-report.json");
    const before = readFileSync(join(root, C18C_ACCEPTANCE_PATCH_PATH), "utf8");

    const report = await runC18cSandboxAcceptance({
      repoRoot: root,
      evidenceRoot,
      reportPath,
      buildImageIfMissing: false,
      ensureImage: async () => ({ available: true, built: false, detail: "fixture image" }),
      runner: mockRunner(true),
      now: () => new Date("2026-11-12T15:00:00.000Z"),
    });

    expect(report.ok).toBe(true);
    expect(report.databaseAccessed).toBe(false);
    expect(report.ollamaModified).toBe(false);
    expect(report.modelsDownloaded).toBe(false);
    expect(report.gpuUsed).toBe(false);
    expect(report.trainingLaunched).toBe(false);
    expect(report.productionRepoUnchanged).toBe(true);
    expect(report.workspacePreserved).toBe(false);
    expect(report.dockerIsolationVerified).toBe(true);
    expect(readFileSync(join(root, C18C_ACCEPTANCE_PATCH_PATH), "utf8")).toBe(before);
    expect(before.includes(C18C_ACCEPTANCE_MARKER)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(join(evidenceRoot, report.experimentId, "evidence.json"))).toBe(true);
    expect(existsSync(join(evidenceRoot, report.experimentId, "validation-audit.json"))).toBe(true);
    expect(report.notes.some((note) => /GPU VM/i.test(note) && /pending/i.test(note))).toBe(true);
  });

  it("fails closed when Docker isolation cannot be established", async () => {
    const root = fixtureRepo();
    const report = await runC18cSandboxAcceptance({
      repoRoot: root,
      evidenceRoot: tempDir("c18c-accept-evidence-"),
      reportPath: join(tempDir("c18c-accept-report-"), "acceptance-report.json"),
      buildImageIfMissing: false,
      ensureImage: async () => ({ available: false, built: false, detail: "image missing" }),
      runner: mockRunner(false),
    });
    expect(report.ok).toBe(false);
    expect(report.dockerIsolationVerified).toBe(false);
    expect(report.sandbox.failureCode).toBe("sandbox_unavailable");
    expect(report.checks.some((check) => check.id === "docker_isolation_probe" && !check.ok)).toBe(true);
  });
});
