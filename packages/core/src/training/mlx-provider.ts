import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "../errors/domain-error.js";
import { TRAINING_BUDGETS } from "./profiles.js";
import { assertInsideRoot, assertInterpreter, trainingScript } from "./paths.js";
import type { PredictJob, TrainHooks, TrainJob, TrainMetric, TrainResult, TrainingProvider } from "./provider.js";

const SAFE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "HF_HOME", "HF_HUB_CACHE", "USER", "LOGNAME"];

export class MlxTrainingProvider implements TrainingProvider {
  readonly kind = "mlx" as const;

  constructor(
    private readonly options: {
      pythonPath: string;
      scriptsDir: string;
    },
  ) {}

  async ready(): Promise<{ ready: boolean; detail: string }> {
    try {
      assertInterpreter(this.options.pythonPath);
      trainingScript(this.options.scriptsDir, "train_lora.py");
      return { ready: true, detail: "mlx-lm launcher is present" };
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? error.message : "mlx launcher is unavailable" };
    }
  }

  async train(job: TrainJob, hooks: TrainHooks): Promise<TrainResult> {
    const script = trainingScript(this.options.scriptsDir, "train_lora.py");
    const jobPath = join(job.outputDir, "job.json");
    writeFileSync(jobPath, JSON.stringify({ ...job, profile: "gemma3-270m-math-v1" }));
    await this.spawn(script, jobPath);
    return this.readTrainResult(job, hooks);
  }

  async predict(job: PredictJob): Promise<string[]> {
    const script = trainingScript(this.options.scriptsDir, job.mode === "candidate" ? "generate_lora.py" : "eval_lora.py");
    mkdirSync(job.outputDir, { recursive: true });
    const jobPath = join(job.outputDir, `${job.mode}-job.json`);
    writeFileSync(
      jobPath,
      JSON.stringify({
        profile: "gemma3-270m-math-v1",
        family: "gemma-3",
        modelPath: job.modelPath,
        adapterPath: job.adapterPath,
        expectedAdapterSha256: job.expectedAdapterSha256,
        prompts: job.prompts,
        maxTokens: 8,
        temperature: 0,
        outputPath: join(job.outputDir, `${job.mode}-predictions.json`),
      }),
    );
    await this.spawn(script, jobPath);
    const payload = JSON.parse(readFileSync(join(job.outputDir, `${job.mode}-predictions.json`), "utf8")) as { predictions?: string[]; loadedAdapter?: boolean };
    if (job.mode === "candidate" && payload.loadedAdapter !== true) {
      throw new DomainError("ADAPTER_NOT_LOADED", "Experimental inference did not load the adapter", 422);
    }
    if (!Array.isArray(payload.predictions) || payload.predictions.length !== job.prompts.length) {
      throw new DomainError("EVALUATION_FAILED", "The trainer returned a different number of predictions", 422);
    }
    return payload.predictions.map((value) => String(value));
  }

  private async spawn(script: string, jobPath: string): Promise<void> {
    const python = assertInterpreter(this.options.pythonPath);
    const args = [script, "--job", assertInsideRoot(join(jobPath, ".."), jobPath)];
    if (args.some((arg) => arg.includes("qwen"))) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "The training launcher cannot target Qwen", 409);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of SAFE_ENV) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, args, { shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new DomainError("BUDGET_EXCEEDED", "Training exceeded the runtime budget", 422));
      }, TRAINING_BUDGETS.maxRuntimeMs);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new DomainError("TRAINING_FAILED", error.message, 422));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        const tail = Buffer.concat(stderr).subarray(-2000).toString("utf8");
        reject(new DomainError("TRAINING_FAILED", tail || `trainer exited ${code ?? "null"}`, 422));
      });
    });
  }

  private async readTrainResult(job: TrainJob, hooks: TrainHooks): Promise<TrainResult> {
    const payload = JSON.parse(readFileSync(join(job.outputDir, "result.json"), "utf8")) as {
      cancelled?: boolean;
      artifactPath?: string | null;
      format?: "safetensors";
      durationMs?: number;
      peakMemoryBytes?: number | null;
      trainLoss?: number | null;
      validationLoss?: number | null;
      metrics?: TrainMetric[];
    };
    const metrics = payload.metrics ?? [];
    for (const metric of metrics) {
      await hooks.metric(metric);
    }
    return {
      cancelled: payload.cancelled === true,
      artifactPath: payload.artifactPath ?? null,
      format: "safetensors",
      durationMs: payload.durationMs ?? 0,
      peakMemoryBytes: payload.peakMemoryBytes ?? null,
      trainLoss: payload.trainLoss ?? null,
      validationLoss: payload.validationLoss ?? null,
      metrics,
    };
  }
}
