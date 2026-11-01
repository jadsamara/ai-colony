export interface TrainMetric {
  step: number;
  trainLoss: number | null;
  validationLoss: number | null;
  learningRate: number | null;
}

export interface TrainJob {
  runId: string;
  outputDir: string;
  dataDir: string;
  modelPath: string;
  family: "gemma-3";
  learningRate: number;
  steps: number;
  seed: number;
  rank: number;
  scale: number;
  dropout: number;
  batchSize: number;
  gradAccum: number;
  maxSeq: number;
  numLayers: number;
  targetModules: string[];
  cancelPath: string;
}

export interface TrainHooks {
  metric(metric: TrainMetric): Promise<void>;
  cancelled(): Promise<boolean>;
}

export interface TrainResult {
  cancelled: boolean;
  artifactPath: string | null;
  format: "float32-bin" | "safetensors";
  durationMs: number;
  peakMemoryBytes: number | null;
  trainLoss: number | null;
  validationLoss: number | null;
  metrics: TrainMetric[];
}

export interface PredictJob {
  mode: "baseline" | "candidate";
  prompts: string[];
  modelPath: string;
  adapterPath: string | null;
  expectedAdapterSha256: string | null;
  artifactRoot: string;
  outputDir: string;
}

export interface TrainingProvider {
  readonly kind: "scripted" | "mlx";
  ready(): Promise<{ ready: boolean; detail: string }>;
  train(job: TrainJob, hooks: TrainHooks): Promise<TrainResult>;
  predict(job: PredictJob): Promise<string[]>;
}
