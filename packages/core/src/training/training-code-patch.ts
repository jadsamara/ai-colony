import { createHash } from "node:crypto";
import { DomainError } from "../errors/domain-error.js";
import {
  fingerprintCodePatch,
  trainingCodePatchSchema,
  type TrainingCodePatch,
} from "./department-learning-spec.js";

/**
 * Explicit allowlist for agent-proposed LoRA training-code edits.
 * Paths are repo-relative POSIX paths. Production Ollama and apps/ are never writable here.
 */
export const TRAINING_CODE_ALLOWLIST = [
  "services/training/train_lora.py",
  "services/training/eval_lora.py",
  "services/training/generate_lora.py",
  "services/training/common.py",
  "services/training/cuda/train_lora_cuda.py",
  "services/training/cuda/common_cuda.py",
] as const;

export type TrainingCodeAllowPath = (typeof TRAINING_CODE_ALLOWLIST)[number];

export interface CodePatchValidationIssue {
  code:
    | "path_not_allowlisted"
    | "path_escape"
    | "invalid_diff"
    | "syntax_hook_failed"
    | "dependency_hook_failed"
    | "empty_patch"
    | "revision_mismatch";
  path?: string;
  message: string;
}

export interface CodePatchValidationResult {
  ok: boolean;
  issues: CodePatchValidationIssue[];
  allowlistedPaths: string[];
  rejectedPaths: string[];
  patchFingerprint: string;
  /** Hooks are recorded so later milestones can run them without changing this contract. */
  hooks: {
    syntax: "pending" | "passed" | "failed" | "skipped";
    dependency: "pending" | "passed" | "failed" | "skipped";
    tests: "pending" | "passed" | "failed" | "skipped";
  };
}

const FORBIDDEN_PATH_FRAGMENTS = [
  "..",
  "apps/",
  "packages/",
  "deploy/",
  "docker-compose",
  ".env",
  "node_modules/",
  "ollama",
] as const;

/**
 * Deterministic validation of a training-code patch proposal.
 * Does not apply the patch and does not execute model-generated Python.
 */
export function validateTrainingCodePatch(input: unknown): CodePatchValidationResult {
  const parsed = trainingCodePatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 8).map((issue) => ({
        code: "invalid_diff" as const,
        message: `${issue.path.join(".") || "patch"}: ${issue.message}`,
      })),
      allowlistedPaths: [],
      rejectedPaths: [],
      patchFingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      hooks: { syntax: "skipped", dependency: "skipped", tests: "skipped" },
    };
  }
  const patch = parsed.data;
  const issues: CodePatchValidationIssue[] = [];
  const allowlistedPaths: string[] = [];
  const rejectedPaths: string[] = [];

  if (patch.files.length === 0) {
    issues.push({ code: "empty_patch", message: "Patch contains no files" });
  }

  const contentFingerprint = computePatchContentFingerprint(patch);
  if (patch.modifiedRevision !== contentFingerprint) {
    issues.push({
      code: "revision_mismatch",
      message: "modifiedRevision must equal the sha256 fingerprint of the proposed diffs",
    });
  }

  for (const file of patch.files) {
    const normalized = normalizeRepoPath(file.path);
    if (!normalized.ok) {
      rejectedPaths.push(file.path);
      issues.push({ code: "path_escape", path: file.path, message: normalized.reason });
      continue;
    }
    if (!isAllowlisted(normalized.path)) {
      rejectedPaths.push(normalized.path);
      issues.push({
        code: "path_not_allowlisted",
        path: normalized.path,
        message: `Path is outside the training-code allowlist`,
      });
      continue;
    }
    if (!looksLikeUnifiedDiff(file.unifiedDiff, file.action)) {
      issues.push({
        code: "invalid_diff",
        path: normalized.path,
        message: "File change is not a usable unified diff",
      });
      continue;
    }
    const syntax = runSyntaxHook(normalized.path, file.unifiedDiff);
    if (!syntax.ok) {
      issues.push({ code: "syntax_hook_failed", path: normalized.path, message: syntax.message });
    }
    const deps = runDependencyHook(file.unifiedDiff);
    if (!deps.ok) {
      issues.push({ code: "dependency_hook_failed", path: normalized.path, message: deps.message });
    }
    allowlistedPaths.push(normalized.path);
  }

  const syntaxFailed = issues.some((issue) => issue.code === "syntax_hook_failed");
  const dependencyFailed = issues.some((issue) => issue.code === "dependency_hook_failed");
  return {
    ok: issues.length === 0,
    issues,
    allowlistedPaths: [...new Set(allowlistedPaths)],
    rejectedPaths: [...new Set(rejectedPaths)],
    patchFingerprint: fingerprintCodePatch(patch),
    hooks: {
      syntax: syntaxFailed ? "failed" : allowlistedPaths.length > 0 ? "passed" : "skipped",
      dependency: dependencyFailed ? "failed" : allowlistedPaths.length > 0 ? "passed" : "skipped",
      // Test execution of patched trainers is deferred; hook is reserved.
      tests: "skipped",
    },
  };
}

export function assertTrainingCodePatch(input: unknown): TrainingCodePatch {
  const parsed = trainingCodePatchSchema.parse(input);
  const result = validateTrainingCodePatch(parsed);
  if (!result.ok) {
    throw new DomainError(
      "TRAINING_COMMAND_REJECTED",
      result.issues.map((issue) => issue.message).join("; ") || "Training code patch rejected",
      422,
    );
  }
  return parsed;
}

export function computePatchContentFingerprint(patch: Omit<TrainingCodePatch, "modifiedRevision"> & { modifiedRevision?: string }): string {
  return createHash("sha256")
    .update(
      patch.files
        .map((file) => `${file.action}\n${file.path}\n${file.unifiedDiff}`)
        .sort()
        .join("\n---\n"),
    )
    .digest("hex");
}

function normalizeRepoPath(path: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) {
    return { ok: false, reason: "Path must be a non-absolute repo-relative path" };
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    return { ok: false, reason: "Path escapes the repository root" };
  }
  for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
    if (fragment === ".." && parts.includes("..")) {
      return { ok: false, reason: "Path escapes the repository root" };
    }
    if (fragment !== ".." && trimmed.includes(fragment)) {
      return { ok: false, reason: `Path touches a forbidden area (${fragment})` };
    }
  }
  return { ok: true, path: trimmed };
}

function isAllowlisted(path: string): boolean {
  return (TRAINING_CODE_ALLOWLIST as readonly string[]).includes(path);
}

function looksLikeUnifiedDiff(diff: string, action: "modify" | "add" | "delete"): boolean {
  if (action === "delete") {
    return /^-{3}\s/.test(diff) || diff.includes("deleted file") || diff.trim().length > 0;
  }
  // Require at least one hunk or a clear new-file marker; reject free-form prose.
  return /^diff --git |^---\s|^@@\s/m.test(diff) || (action === "add" && diff.includes("+++"));
}

/**
 * Lightweight static syntax hook — does not execute the patched module.
 * Rejects obvious non-Python payloads and unbalanced triple quotes for .py files.
 */
function runSyntaxHook(path: string, diff: string): { ok: boolean; message: string } {
  if (!path.endsWith(".py")) {
    return { ok: false, message: "Only Python training modules are allowed in this milestone" };
  }
  if (/```|<\/?(script|html)/i.test(diff)) {
    return { ok: false, message: "Diff contains non-Python markup" };
  }
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  const quotes = (added.match(/"""/g) ?? []).length + (added.match(/'''/g) ?? []).length;
  if (quotes % 2 !== 0) {
    return { ok: false, message: "Added Python fragment has unbalanced triple quotes" };
  }
  return { ok: true, message: "ok" };
}

/**
 * Dependency hook — blocks introducing imports outside a small allowlist.
 * Full environment resolution is deferred.
 */
function runDependencyHook(diff: string): { ok: boolean; message: string } {
  const addedImports = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => /^(?:import|from)\s+/.test(line));
  const allowed = /^(?:import|from)\s+(?:mlx|mlx_lm|numpy|json|os|sys|argparse|pathlib|typing|dataclasses|hashlib|math|re|tempfile|subprocess|torch|transformers|peft|trl|accelerate|datasets|common_cuda|common)\b/;
  for (const line of addedImports) {
    if (!allowed.test(line)) {
      return { ok: false, message: `Import not allowlisted for training scripts: ${line.slice(0, 80)}` };
    }
  }
  return { ok: true, message: "ok" };
}
