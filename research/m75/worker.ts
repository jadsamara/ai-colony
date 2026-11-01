import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "./io.js";
import { RESEARCH_PROFILE } from "./protocol.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const PATHS = {
  root: ROOT,
  python: join(ROOT, "services/training/.venv/bin/python"),
  script: join(ROOT, "services/training/research_m75.py"),
  artifacts: join(ROOT, "services/training/research-artifacts"),
  results: join(ROOT, "services/training/results/m75"),
  checkpoint: join(ROOT, "services/training/checkpoints/Qwen3-1.7B-MLX-4bit"),
  fallbackCheckpoint: join(ROOT, "services/training/checkpoints/Qwen3-0.6B-4bit"),
};

export async function runPython(args: string[], timeoutMs: number): Promise<void> {
  if (!existsSync(PATHS.python)) {
    throw new Error("the MLX virtualenv is missing");
  }
  const stderr: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PATHS.python, args, { shell: false, env: safeEnv(), stdio: ["ignore", "inherit", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("python command timed out"));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).subarray(-2000).toString("utf8") || `python exited ${code ?? "null"}`));
    });
  });
}

export async function runWorker(job: Record<string, unknown>, name: string, timeoutMs: number): Promise<void> {
  if (!existsSync(PATHS.python)) {
    throw new Error("the MLX virtualenv is missing");
  }
  const jobPath = join(PATHS.artifacts, "jobs", `${name}.json`);
  writeJson(jobPath, { profile: RESEARCH_PROFILE, family: "qwen3", ...job });
  const stderr: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PATHS.python, [PATHS.script, "--job", jobPath], {
      shell: false,
      env: safeEnv(),
      stdio: ["ignore", "inherit", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`research worker timed out: ${name}`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).subarray(-2000).toString("utf8") || `research worker exited ${code ?? "null"}`));
    });
  });
}

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1" };
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "HF_HOME", "HF_HUB_CACHE"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
