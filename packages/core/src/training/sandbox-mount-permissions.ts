import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Fixed sandbox identity from deploy/Dockerfile.training-sandbox. */
export const SANDBOX_CONTAINER_UID = 10001 as const;
export const SANDBOX_CONTAINER_GID = 10001 as const;

export type SandboxMountPermissionMethod = "acl" | "mode";

export interface PrepareSandboxMountPermissionsInput {
  workspaceRoot: string;
  scratchRoot: string;
  evidenceRoot: string;
  /** Defaults to SANDBOX_CONTAINER_UID. */
  containerUid?: number;
  /** Defaults to process.getuid() when available. */
  hostUid?: number;
}

export interface PrepareSandboxMountPermissionsResult {
  ok: boolean;
  method: SandboxMountPermissionMethod | "none";
  detail: string;
  containerUid: number;
  hostUid: number;
}

/**
 * Prepare bind-mount directories so container UID 10001 can read the
 * read-only workspace and write scratch/evidence, while the host retains
 * cleanup/evidence collection rights.
 *
 * Preference order:
 * 1. Restricted POSIX ACLs (setfacl) — Linux GPU VM
 * 2. Narrow mode bits on only these mount roots (no service-wide root)
 *
 * Fails closed when neither can be established or verification fails.
 */
export function prepareSandboxMountPermissions(
  input: PrepareSandboxMountPermissionsInput,
): PrepareSandboxMountPermissionsResult {
  const containerUid = input.containerUid ?? SANDBOX_CONTAINER_UID;
  const hostUid = input.hostUid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const workspaceRoot = resolve(input.workspaceRoot);
  const scratchRoot = resolve(input.scratchRoot);
  const evidenceRoot = resolve(input.evidenceRoot);

  for (const dir of [workspaceRoot, scratchRoot, evidenceRoot]) {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
      return {
        ok: false,
        method: "none",
        detail: `Mount path missing or not a directory: ${dir}`,
        containerUid,
        hostUid,
      };
    }
  }

  // Ensure nested writable paths exist before ACL/mode application.
  mkdirSync(join(scratchRoot, "output"), { recursive: true });
  mkdirSync(join(scratchRoot, "pycache"), { recursive: true });

  const acl = tryApplyPosixAcl({
    workspaceRoot,
    scratchRoot,
    evidenceRoot,
    containerUid,
    hostUid,
  });
  if (acl.ok) {
    const verified = verifyMountPermissions({
      workspaceRoot,
      scratchRoot,
      evidenceRoot,
      method: "acl",
      containerUid,
    });
    if (!verified.ok) {
      return {
        ok: false,
        method: "none",
        detail: `ACL applied but verification failed: ${verified.detail}`,
        containerUid,
        hostUid,
      };
    }
    return {
      ok: true,
      method: "acl",
      detail: acl.detail,
      containerUid,
      hostUid,
    };
  }

  const mode = applyModeFallback({ workspaceRoot, scratchRoot, evidenceRoot });
  if (!mode.ok) {
    return {
      ok: false,
      method: "none",
      detail: `POSIX ACL unavailable (${acl.detail}); mode fallback failed: ${mode.detail}`,
      containerUid,
      hostUid,
    };
  }
  const verified = verifyMountPermissions({
    workspaceRoot,
    scratchRoot,
    evidenceRoot,
    method: "mode",
    containerUid,
  });
  if (!verified.ok) {
    return {
      ok: false,
      method: "none",
      detail: `Mode fallback applied but verification failed: ${verified.detail}`,
      containerUid,
      hostUid,
    };
  }
  return {
    ok: true,
    method: "mode",
    detail: `${mode.detail}; acl_unavailable=${acl.detail}`,
    containerUid,
    hostUid,
  };
}

function tryApplyPosixAcl(input: {
  workspaceRoot: string;
  scratchRoot: string;
  evidenceRoot: string;
  containerUid: number;
  hostUid: number;
}): { ok: boolean; detail: string } {
  if (!commandExists("setfacl")) {
    return { ok: false, detail: "setfacl not found" };
  }

  const { workspaceRoot, scratchRoot, evidenceRoot, containerUid, hostUid } = input;
  // Workspace: container may read/traverse only (docker still mounts :ro).
  const workspaceAcl = runSetfacl([
    "-R",
    "-m",
    `u:${containerUid}:rX`,
    "-m",
    `d:u:${containerUid}:rX`,
    "-m",
    `u:${hostUid}:rwX`,
    "-m",
    `d:u:${hostUid}:rwX`,
    workspaceRoot,
  ]);
  if (!workspaceAcl.ok) {
    return workspaceAcl;
  }

  // Scratch + evidence: container read/write; host keeps cleanup rights via ACL defaults.
  for (const root of [scratchRoot, evidenceRoot]) {
    const result = runSetfacl([
      "-R",
      "-m",
      `u:${containerUid}:rwX`,
      "-m",
      `d:u:${containerUid}:rwX`,
      "-m",
      `u:${hostUid}:rwX`,
      "-m",
      `d:u:${hostUid}:rwX`,
      root,
    ]);
    if (!result.ok) {
      return result;
    }
  }
  return {
    ok: true,
    detail: `setfacl granted u:${containerUid} on workspace(rX) scratch/evidence(rwX); host u:${hostUid} retained`,
  };
}

function applyModeFallback(input: {
  workspaceRoot: string;
  scratchRoot: string;
  evidenceRoot: string;
}): { ok: boolean; detail: string } {
  try {
    // Workspace stays host-owned; others need traverse+read for container UID.
    chmodTree(input.workspaceRoot, { dirMode: 0o755, fileMode: 0o644 });
    // Only dedicated scratch/evidence mounts become world-accessible; not the repo.
    chmodTree(input.scratchRoot, { dirMode: 0o777, fileMode: 0o666 });
    chmodTree(input.evidenceRoot, { dirMode: 0o777, fileMode: 0o666 });
    return {
      ok: true,
      detail: "mode fallback workspace=0755 scratch/evidence=0777 (dedicated mounts only)",
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Best-effort verification that mount roots are usable for the sandbox contract.
 * Does not require root; checks mode bits and/or ACL listings when available.
 */
export function verifyMountPermissions(input: {
  workspaceRoot: string;
  scratchRoot: string;
  evidenceRoot: string;
  method: SandboxMountPermissionMethod;
  containerUid: number;
}): { ok: boolean; detail: string } {
  try {
    // Probe host write into nested dirs (cleanup / staging contract).
    const probe = join(input.scratchRoot, "pycache", `.host-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    const evidenceProbe = join(input.evidenceRoot, `.host-probe-${process.pid}`);
    writeFileSync(evidenceProbe, "ok");
    rmSync(probe, { force: true });
    rmSync(evidenceProbe, { force: true });

    if (input.method === "mode") {
      const scratchMode = lstatSync(input.scratchRoot).mode & 0o777;
      const evidenceMode = lstatSync(input.evidenceRoot).mode & 0o777;
      const workspaceMode = lstatSync(input.workspaceRoot).mode & 0o777;
      if ((scratchMode & 0o007) !== 0o007 || (evidenceMode & 0o007) !== 0o007) {
        return {
          ok: false,
          detail: `scratch/evidence other bits insufficient (scratch=${scratchMode.toString(8)} evidence=${evidenceMode.toString(8)})`,
        };
      }
      if ((workspaceMode & 0o005) !== 0o005) {
        return {
          ok: false,
          detail: `workspace not other-readable/executable (mode=${workspaceMode.toString(8)})`,
        };
      }
    }

    if (input.method === "acl" && commandExists("getfacl")) {
      for (const [label, path] of [
        ["scratch", input.scratchRoot],
        ["evidence", input.evidenceRoot],
      ] as const) {
        const listed = spawnSync("getfacl", ["-p", path], { encoding: "utf8" });
        if (listed.status !== 0 || !listed.stdout.includes(`user:${input.containerUid}:`)) {
          return {
            ok: false,
            detail: `getfacl missing u:${input.containerUid} on ${label}`,
          };
        }
      }
    }

    return { ok: true, detail: "host probes succeeded; mount modes/ACLs acceptable" };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function chmodTree(root: string, modes: { dirMode: number; fileMode: number }): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to chmod symlink mount root: ${root}`);
  }
  if (stat.isDirectory()) {
    chmodSync(root, modes.dirMode);
    for (const entry of readdirSync(root)) {
      chmodTree(join(root, entry), modes);
    }
    return;
  }
  if (stat.isFile()) {
    chmodSync(root, modes.fileMode);
  }
}

function runSetfacl(args: string[]): { ok: boolean; detail: string } {
  const result = spawnSync("setfacl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || `setfacl exit ${result.status}`).trim(),
    };
  }
  return { ok: true, detail: "ok" };
}

function commandExists(name: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0;
}
