import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DomainError } from "../errors/domain-error.js";
import type { TrainingCodePatch } from "./department-learning-spec.js";
import { TRAINING_CODE_ALLOWLIST } from "./training-code-patch.js";

export interface TreeFileHash {
  path: string;
  sha256: string;
  bytes: number;
}

export interface AppliedPatchWorkspace {
  workspaceRoot: string;
  originalHashes: TreeFileHash[];
  modifiedHashes: TreeFileHash[];
  originalTreeHash: string;
  modifiedTreeHash: string;
  touchedPaths: string[];
}

/**
 * Hash allowlisted training files under a repository / fixture root.
 */
export function hashAllowlistedTree(sourceRoot: string): { files: TreeFileHash[]; treeHash: string } {
  const files: TreeFileHash[] = [];
  for (const rel of TRAINING_CODE_ALLOWLIST) {
    const abs = resolve(sourceRoot, rel);
    if (!existsSync(abs)) {
      continue;
    }
    assertNoSymlink(abs, rel);
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) {
      throw new DomainError("TRAINING_COMMAND_REJECTED", `Binary file is not allowed: ${rel}`, 422);
    }
    files.push({ path: rel, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return { files, treeHash: treeFingerprint(files) };
}

/**
 * Copy only allowlisted training files into an isolated workspace, then apply the patch.
 * Does not modify the production repository.
 */
export function materializePatchedWorkspace(input: {
  sourceRoot: string;
  workspaceRoot: string;
  patch: TrainingCodePatch;
  expectedBaseRevision?: string;
}): AppliedPatchWorkspace {
  const sourceRoot = resolve(input.sourceRoot);
  const workspaceRoot = resolve(input.workspaceRoot);
  if (workspaceRoot === sourceRoot || workspaceRoot.startsWith(sourceRoot + sep)) {
    throw new DomainError(
      "TRAINING_COMMAND_REJECTED",
      "Sandbox workspace must not be nested inside the production source root",
      422,
    );
  }

  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });

  for (const rel of TRAINING_CODE_ALLOWLIST) {
    const from = resolve(sourceRoot, rel);
    if (!existsSync(from)) {
      continue;
    }
    assertNoSymlink(from, rel);
    const to = resolve(workspaceRoot, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    chmodSync(to, 0o644);
  }

  const original = hashAllowlistedTree(workspaceRoot);
  const expected = input.expectedBaseRevision ?? input.patch.baseRevision;
  if (expected !== original.treeHash) {
    throw new DomainError(
      "TRAINING_COMMAND_REJECTED",
      "Patch baseRevision does not match the isolated source tree hash",
      409,
    );
  }

  for (const file of input.patch.files) {
    if (!(TRAINING_CODE_ALLOWLIST as readonly string[]).includes(file.path)) {
      throw new DomainError("TRAINING_COMMAND_REJECTED", `Unauthorized path in patch apply: ${file.path}`, 422);
    }
    if (looksBinaryDiff(file.unifiedDiff)) {
      throw new DomainError("TRAINING_COMMAND_REJECTED", `Binary patches are rejected: ${file.path}`, 422);
    }
    const target = resolve(workspaceRoot, file.path);
    assertInside(workspaceRoot, target);
    if (file.action === "delete") {
      if (existsSync(target)) {
        assertNoSymlink(target, file.path);
        rmSync(target);
      }
      continue;
    }
    const before = existsSync(target) ? readFileSync(target, "utf8") : "";
    const after = applyUnifiedDiff(before, file.unifiedDiff, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, after, "utf8");
    chmodSync(target, 0o644);
  }

  rejectSymlinksAndEscapes(workspaceRoot);
  const modified = hashAllowlistedTree(workspaceRoot);
  return {
    workspaceRoot,
    originalHashes: original.files,
    modifiedHashes: modified.files,
    originalTreeHash: original.treeHash,
    modifiedTreeHash: modified.treeHash,
    touchedPaths: input.patch.files.map((file) => file.path),
  };
}

export function applyUnifiedDiff(original: string, diffText: string, pathForErrors: string): string {
  if (looksBinaryDiff(diffText)) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", `Binary patch rejected for ${pathForErrors}`, 422);
  }
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  // Full-file replacement marker used by tests / add actions.
  if (lines.some((line) => line === "*** Add File ***" || line.startsWith("+++ ")) && !lines.some((line) => line.startsWith("@@"))) {
    const added = lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    if (added.length > 0) {
      return added.join("\n") + (added[added.length - 1] === "" ? "" : "\n");
    }
  }

  const hunks = parseHunks(lines);
  if (hunks.length === 0) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", `No hunks found for ${pathForErrors}`, 422);
  }

  const source = original.replace(/\r\n/g, "\n").split("\n");
  // Drop trailing empty element from final newline split consistency.
  if (source.length > 0 && source[source.length - 1] === "") {
    source.pop();
  }
  let cursor = 0;
  const output: string[] = [];

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) {
      throw new DomainError("TRAINING_COMMAND_REJECTED", `Overlapping hunk for ${pathForErrors}`, 422);
    }
    output.push(...source.slice(cursor, start));
    let oldIndex = start;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        if (source[oldIndex] !== line.slice(1)) {
          throw new DomainError(
            "TRAINING_COMMAND_REJECTED",
            `Context mismatch applying patch to ${pathForErrors}`,
            409,
          );
        }
        output.push(line.slice(1));
        oldIndex += 1;
      } else if (line.startsWith("-")) {
        if (source[oldIndex] !== line.slice(1)) {
          throw new DomainError(
            "TRAINING_COMMAND_REJECTED",
            `Delete mismatch applying patch to ${pathForErrors}`,
            409,
          );
        }
        oldIndex += 1;
      } else if (line.startsWith("+")) {
        output.push(line.slice(1));
      }
    }
    cursor = oldIndex;
  }
  output.push(...source.slice(cursor));
  return output.join("\n") + "\n";
}

function parseHunks(lines: string[]): Array<{ oldStart: number; lines: string[] }> {
  const hunks: Array<{ oldStart: number; lines: string[] }> = [];
  let current: { oldStart: number; lines: string[] } | null = null;
  for (const line of lines) {
    const header = /^@@\s+-([0-9]+)(?:,[0-9]+)?\s+\+[0-9]+(?:,[0-9]+)?\s@@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "\\ No newline at end of file") {
      if (line !== "\\ No newline at end of file") {
        current.lines.push(line);
      }
    }
  }
  return hunks;
}

function looksBinaryDiff(diffText: string): boolean {
  return diffText.includes("GIT binary patch") || diffText.includes("\0") || /Binary files .* differ/.test(diffText);
}

function rejectSymlinksAndEscapes(workspaceRoot: string): void {
  const stack = [workspaceRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      const rel = relative(workspaceRoot, abs).split(sep).join("/");
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        throw new DomainError("TRAINING_COMMAND_REJECTED", `Symlink escape rejected: ${rel}`, 422);
      }
      if (stat.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!stat.isFile()) {
        throw new DomainError("TRAINING_COMMAND_REJECTED", `Unsupported file type in sandbox: ${rel}`, 422);
      }
      if (!(TRAINING_CODE_ALLOWLIST as readonly string[]).includes(rel)) {
        throw new DomainError("TRAINING_COMMAND_REJECTED", `Unauthorized file present after patch: ${rel}`, 422);
      }
    }
  }
}

function assertNoSymlink(abs: string, label: string): void {
  if (lstatSync(abs).isSymbolicLink()) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", `Symlink rejected: ${label}`, 422);
  }
  if (!statSync(abs).isFile()) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", `Expected a regular file: ${label}`, 422);
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", "Path escapes the sandbox workspace", 422);
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeFingerprint(files: TreeFileHash[]): string {
  return createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.sha256}`).sort().join("\n"))
    .digest("hex");
}
