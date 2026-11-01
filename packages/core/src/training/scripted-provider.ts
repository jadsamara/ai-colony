import { writeFileSync } from "node:fs";
import { join } from "node:path";

function weights(values: number[]): Buffer {
  const data = new Float32Array(values);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
import { DomainError } from "../errors/domain-error.js";
import { parseArithmetic } from "./dataset.js";
import { sha256File } from "./files.js";
import type { PredictJob, TrainHooks, TrainJob, TrainResult, TrainingProvider } from "./provider.js";

export interface ScriptedTrainingOptions {
  behavior?: "improve" | "flat";
  fail?: boolean;
  beforeFinish?: () => Promise<void>;
}

export class ScriptedTrainingProvider implements TrainingProvider {
  readonly kind = "scripted" as const;
  fail: boolean;
  failPredict: boolean;
  beforeFinish?: () => Promise<void>;

  constructor(private readonly options: ScriptedTrainingOptions = {}) {
    this.fail = options.fail ?? false;
    this.failPredict = false;
  }

  async ready(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: "scripted provider does not update weights outside a test double" };
  }

  async train(job: TrainJob, hooks: TrainHooks): Promise<TrainResult> {
    const metrics = [
      { step: 1, trainLoss: 1.2, validationLoss: 1.1, learningRate: job.learningRate },
      { step: job.steps, trainLoss: 0.4, validationLoss: 0.45, learningRate: job.learningRate },
    ];
    for (const metric of metrics) {
      await hooks.metric(metric);
    }
    const beforeFinish = this.beforeFinish ?? this.options.beforeFinish;
    if (beforeFinish) {
      await beforeFinish();
    }
    if (await hooks.cancelled()) {
      writeFileSync(join(job.outputDir, "partial.weights"), weights([0.25, -0.5, 0.75, 1]));
      return { cancelled: true, artifactPath: join(job.outputDir, "partial.weights"), format: "float32-bin", durationMs: 5, peakMemoryBytes: null, trainLoss: 1.2, validationLoss: null, metrics };
    }
    if (this.fail || this.options.fail) {
      writeFileSync(join(job.outputDir, "partial.weights"), weights([0.25, -0.5, 0.75, 1]));
      throw new DomainError("TRAINING_FAILED", "worker_failed", 422);
    }
    const artifactPath = join(job.outputDir, "adapter.weights");
    writeFileSync(artifactPath, weights([0.1, -0.2, 0.3, 0.4]));
    return {
      cancelled: false,
      artifactPath,
      format: "float32-bin",
      durationMs: 5,
      peakMemoryBytes: null,
      trainLoss: 0.4,
      validationLoss: 0.45,
      metrics,
    };
  }

  async predict(job: PredictJob): Promise<string[]> {
    if (this.failPredict) {
      throw new DomainError("EVALUATION_FAILED", "scripted evaluation failed", 422);
    }
    if (job.mode === "candidate") {
      if (!job.adapterPath || !job.expectedAdapterSha256) {
        throw new DomainError("ADAPTER_NOT_LOADED", "Candidate inference requires the trained adapter", 409);
      }
      const actual = sha256File(job.artifactRoot, job.adapterPath);
      if (actual !== job.expectedAdapterSha256) {
        throw new DomainError("ARTIFACT_MISMATCH", "Candidate adapter hash does not match the trained artifact", 409);
      }
    }
    return job.prompts.map((prompt) => {
      if (job.mode === "baseline" || this.options.behavior === "flat") {
        return "0";
      }
      return parseArithmetic(prompt)?.expectedOutput ?? "";
    });
  }
}
