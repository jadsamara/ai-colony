import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DomainError } from "../errors/domain-error.js";

const ALLOWED_SCRIPTS = new Set(["train_lora.py", "eval_lora.py", "generate_lora.py"]);

export function assertInsideRoot(root: string, target: string): string {
  if (target.includes("\0")) {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Path is not allowed", 400);
  }
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  const fromRoot = relative(rootResolved, targetResolved);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Path escapes the training root", 400);
  }
  return targetResolved;
}

export function assertCheckpointPath(checkpointRoot: string, target: string): string {
  const lexical = assertInsideRoot(checkpointRoot, target);
  let real = lexical;
  try {
    real = realpathSync(lexical);
  } catch {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Checkpoint path does not exist", 400);
  }
  const cache = resolve(homedir(), ".cache", "huggingface");
  const allowed = isInside(checkpointRoot, real) || isInside(cache, real);
  if (!allowed) {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Checkpoint resolves outside the allowlisted roots", 400);
  }
  return lexical;
}

export function assertRealFileInside(root: string, target: string): string {
  const lexical = assertInsideRoot(root, target);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink()) {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Adapter artifacts cannot be symlinks", 400);
  }
  if (!stat.isFile()) {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Artifact path is not a file", 400);
  }
  const real = realpathSync(lexical);
  if (!isInside(root, real)) {
    throw new DomainError("ARTIFACT_PATH_REJECTED", "Artifact resolves outside the artifact root", 400);
  }
  return real;
}

export function relativeToRoot(root: string, target: string): string {
  return relative(resolve(root), target).split(sep).join("/");
}

export function trainingScript(scriptsDir: string, name: string): string {
  if (!ALLOWED_SCRIPTS.has(name)) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", "Training command is not allowlisted", 400);
  }
  return assertInsideRoot(scriptsDir, resolve(scriptsDir, name));
}

export function assertInterpreter(pythonPath: string): string {
  if (!pythonPath.startsWith("/") || pythonPath.includes("..") || !/\/python(?:3(?:\.\d+)?)?$/.test(pythonPath)) {
    throw new DomainError("TRAINING_COMMAND_REJECTED", "Python interpreter is not allowlisted", 400);
  }
  return pythonPath;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(canonical(root), canonical(target));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
