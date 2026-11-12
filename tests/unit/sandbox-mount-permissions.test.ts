import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SANDBOX_CONTAINER_UID,
  prepareSandboxMountPermissions,
} from "@ai-colony/core";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      chmodSync(root, 0o755);
    } catch {
      // best-effort before recursive delete
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("C1.8C sandbox mount permissions", () => {
  it("prepares 0700 host dirs so a foreign container UID can use scratch/evidence", () => {
    const workspaceRoot = tempDir("c18c-perm-ws-");
    const scratchRoot = tempDir("c18c-perm-scratch-");
    const evidenceRoot = tempDir("c18c-perm-evidence-");
    chmodSync(workspaceRoot, 0o700);
    chmodSync(scratchRoot, 0o700);
    chmodSync(evidenceRoot, 0o700);
    mkdirSync(join(scratchRoot, "output"), { recursive: true });
    mkdirSync(join(scratchRoot, "pycache"), { recursive: true });
    writeFileSync(join(workspaceRoot, "sample.py"), "x = 1\n");
    writeFileSync(join(scratchRoot, "job.json"), "{}\n");

    const hostUid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(hostUid).not.toBe(SANDBOX_CONTAINER_UID);

    const result = prepareSandboxMountPermissions({
      workspaceRoot,
      scratchRoot,
      evidenceRoot,
      containerUid: SANDBOX_CONTAINER_UID,
      hostUid,
    });

    expect(result.ok).toBe(true);
    expect(result.containerUid).toBe(SANDBOX_CONTAINER_UID);
    expect(["acl", "mode"]).toContain(result.method);
    // Host can still write evidence/cleanup paths after prep.
    writeFileSync(join(evidenceRoot, "evidence.json"), "{\"ok\":true}\n");
    expect(existsSync(join(evidenceRoot, "evidence.json"))).toBe(true);
    writeFileSync(join(scratchRoot, "pycache", "host-clean.txt"), "ok\n");
  });

  it("fails closed when a mount root is missing", () => {
    const workspaceRoot = tempDir("c18c-perm-ws-");
    const scratchRoot = tempDir("c18c-perm-scratch-");
    const result = prepareSandboxMountPermissions({
      workspaceRoot,
      scratchRoot,
      evidenceRoot: join(tmpdir(), `c18c-missing-${process.pid}`),
      containerUid: SANDBOX_CONTAINER_UID,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
  });
});
