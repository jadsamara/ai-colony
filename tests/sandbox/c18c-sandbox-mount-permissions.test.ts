/**
 * Integration: container UID 10001 (≠ host UID) must write dedicated scratch/evidence
 * bind mounts after permission prep, with /workspace read-only and network disabled.
 *
 * Skips when Docker or the sandbox/base image is unavailable (local Mac agents often
 * lack daemon access). GPU VM / CI with Docker should execute these checks.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SANDBOX_CONTAINER_GID,
  SANDBOX_CONTAINER_UID,
  TRAINING_SANDBOX_IMAGE,
  prepareSandboxMountPermissions,
} from "@ai-colony/core";

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

function dockerAvailable(): { ok: boolean; detail: string; image: string } {
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (version.status !== 0) {
    return { ok: false, detail: version.stderr || "docker daemon unavailable", image: "" };
  }
  for (const image of [TRAINING_SANDBOX_IMAGE, "python:3.11-slim-bookworm"]) {
    const inspect = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
      encoding: "utf8",
    });
    if (inspect.status === 0) {
      return { ok: true, detail: `docker ${version.stdout.trim()} image=${image}`, image };
    }
  }
  return { ok: false, detail: "no suitable python sandbox image present", image: "" };
}

describe("C1.8C sandbox bind-mount permissions (docker UID isolation)", () => {
  it("rejects container writes into unprepared 0700 scratch mounts", () => {
    const docker = dockerAvailable();
    if (!docker.ok) {
      return;
    }
    const hostUid = process.getuid?.() ?? 0;
    expect(hostUid).not.toBe(SANDBOX_CONTAINER_UID);

    const scratchRoot = tempDir("c18c-int-unprepared-");
    chmodSync(scratchRoot, 0o700);
    mkdirSync(join(scratchRoot, "pycache"), { recursive: true });
    chmodSync(join(scratchRoot, "pycache"), 0o700);

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--user",
        `${SANDBOX_CONTAINER_UID}:${SANDBOX_CONTAINER_GID}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "-v",
        `${scratchRoot}:/scratch:rw`,
        docker.image,
        "python3",
        "-c",
        "open('/scratch/pycache/denied.txt','w').write('x')",
      ],
      { encoding: "utf8" },
    );
    // Native Linux Docker (GPU VM) enforces host DAC; Docker Desktop bind mounts may not.
    if (result.status === 0) {
      return;
    }
    expect(`${result.stderr}${result.stdout}`).toMatch(/Permission denied|Read-only|Errno 13|Errno 30/i);
  });

  it("allows container UID 10001 to write prepared scratch/evidence and read workspace", () => {
    const docker = dockerAvailable();
    if (!docker.ok) {
      return;
    }
    const hostUid = process.getuid?.() ?? 0;
    expect(hostUid).not.toBe(SANDBOX_CONTAINER_UID);

    const workspaceRoot = tempDir("c18c-int-ws-");
    const scratchRoot = tempDir("c18c-int-scratch-");
    const evidenceRoot = tempDir("c18c-int-evidence-");
    chmodSync(workspaceRoot, 0o700);
    chmodSync(scratchRoot, 0o700);
    chmodSync(evidenceRoot, 0o700);
    writeFileSync(join(workspaceRoot, "marker.py"), "VALUE = 1\n");
    mkdirSync(join(scratchRoot, "output"), { recursive: true });
    mkdirSync(join(scratchRoot, "pycache"), { recursive: true });

    const prepared = prepareSandboxMountPermissions({
      workspaceRoot,
      scratchRoot,
      evidenceRoot,
      containerUid: SANDBOX_CONTAINER_UID,
      hostUid,
    });
    expect(prepared.ok).toBe(true);

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--memory",
        "256m",
        "--pids-limit",
        "64",
        "--user",
        `${SANDBOX_CONTAINER_UID}:${SANDBOX_CONTAINER_GID}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "-v",
        `${workspaceRoot}:/workspace:ro`,
        "-v",
        `${scratchRoot}:/scratch:rw`,
        "-v",
        `${evidenceRoot}:/evidence:rw`,
        docker.image,
        "python3",
        "-c",
        [
          "from pathlib import Path",
          "assert Path('/workspace/marker.py').read_text() == 'VALUE = 1\\n'",
          "Path('/scratch/pycache').mkdir(parents=True, exist_ok=True)",
          "Path('/scratch/output').mkdir(parents=True, exist_ok=True)",
          "Path('/scratch/pycache/from-container.txt').write_text('scratch-ok')",
          "Path('/scratch/output/result.json').write_text('{\"ok\":true}')",
          "Path('/evidence/from-container.txt').write_text('evidence-ok')",
          // Workspace is read-only at the Docker mount layer.
          "import errno",
          "try:",
          "    Path('/workspace/evil.py').write_text('nope')",
          "    raise SystemExit('workspace unexpectedly writable')",
          "except OSError as exc:",
          "    assert exc.errno in (errno.EROFS, errno.EACCES, errno.EPERM)",
          "print('mount_permissions_ok')",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("mount_permissions_ok");
    expect(readFileSync(join(scratchRoot, "pycache", "from-container.txt"), "utf8")).toBe("scratch-ok");
    expect(readFileSync(join(evidenceRoot, "from-container.txt"), "utf8")).toBe("evidence-ok");
    // Host retains cleanup / evidence collection.
    writeFileSync(join(evidenceRoot, "host-evidence.json"), "{\"collected\":true}\n");
    rmSync(join(scratchRoot, "pycache", "from-container.txt"));
  });
});
