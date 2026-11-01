import { DomainError } from "../errors/domain-error.js";
import { meanExposures } from "./stability.js";

export type MethodStatus = "implemented" | "unsupported";

export interface TrainingMethod {
  id: string;
  version: string;
  status: MethodStatus;
  architectures: string[];
  backend: string;
  dataFormat: string;
  hyperparameters: string[];
  knownRisks: string[];
}

export const TRAINING_METHODS: readonly TrainingMethod[] = [
  {
    id: "lora-supervised",
    version: "m75b-v1",
    status: "implemented",
    architectures: ["qwen3"],
    backend: "mlx-lm",
    dataFormat: "verified-integer-answer",
    hyperparameters: ["learningRate", "steps", "rank", "numLayers", "datasetSize"],
    knownRisks: ["M7.5 Phase 1: 80 steps at learning rate 0.0001 on about 25 examples regressed Qwen3-1.7B on a fresh arithmetic holdout."],
  },
  {
    id: "verified-rejection-sft",
    version: "m75b-v1",
    status: "implemented",
    architectures: ["qwen3"],
    backend: "mlx-lm",
    dataFormat: "model-successes-retargeted-to-verified-integers",
    hyperparameters: ["learningRate", "steps", "rank", "numLayers", "datasetSize"],
    knownRisks: ["The same optimizer as lora-supervised. M7.5 self-verified runs also regressed."],
  },
  {
    id: "structured-solution-sft",
    version: "m75b-v1",
    status: "implemented",
    architectures: ["qwen3"],
    backend: "mlx-lm",
    dataFormat: "programmatically-verified-intermediate-equations",
    hyperparameters: ["learningRate", "steps", "rank", "numLayers", "datasetSize"],
    knownRisks: ["Intermediate steps are trained, but the scored objective remains the final integer."],
  },
  { id: "reinforcement-learning", version: "unsupported", status: "unsupported", architectures: [], backend: "none", dataFormat: "none", hyperparameters: [], knownRisks: ["Not implemented."] },
  { id: "preference-optimization", version: "unsupported", status: "unsupported", architectures: [], backend: "none", dataFormat: "none", hyperparameters: [], knownRisks: ["Not implemented."] },
  { id: "distillation", version: "unsupported", status: "unsupported", architectures: [], backend: "none", dataFormat: "none", hyperparameters: [], knownRisks: ["Not implemented."] },
  { id: "continual-learning-rehearsal", version: "unsupported", status: "unsupported", architectures: [], backend: "none", dataFormat: "none", hyperparameters: [], knownRisks: ["Not implemented."] },
  { id: "self-supervised-adaptation", version: "unsupported", status: "unsupported", architectures: [], backend: "none", dataFormat: "none", hyperparameters: [], knownRisks: ["Not implemented."] },
  { id: "meta-learning", version: "unsupported", status: "unsupported", architectures: [], backend: "none", dataFormat: "none", hyperparameters: [], knownRisks: ["Not implemented."] },
];

export interface ExperimentRecord {
  id: string;
  methodId: string;
  steps: number;
  learningRate: number;
  datasetSize: number;
  target: "answer" | "structured";
  seed: number;
  devAccuracy: number | null;
  baselineAccuracy: number | null;
  sealedAccuracy: number | null;
  retentionOk: boolean | null;
  failureClass: string | null;
  evidencePath: string;
}

export interface PlanRecommendation {
  action: "no-weight-training" | "zero-step-control" | "smaller-update" | "more-data" | "structured-target" | "reject-configuration" | "no-promotion";
  methodId: string | null;
  executable: boolean;
  reason: string;
  config: { learningRate: number; steps: number; datasetSize: number; target: "answer" | "structured" } | null;
  deployment: "ineligible";
  citedExperimentIds: string[];
}

export function methodById(id: string): TrainingMethod {
  const method = TRAINING_METHODS.find((item) => item.id === id);
  if (method === undefined) {
    throw new DomainError("NOT_SUPPORTED", `Training method ${id} is not registered`, 422);
  }
  return method;
}

export function assertMethodExecutable(id: string, architecture: string): TrainingMethod {
  const method = methodById(id);
  if (method.status !== "implemented" || !method.architectures.includes(architecture)) {
    throw new DomainError("NOT_SUPPORTED", `${id} cannot train ${architecture}`, 422);
  }
  return method;
}

export function assertSafeConfig(input: { steps: number; learningRate: number; datasetSize: number; sealedItemIds: string[]; trainItemIds: string[] }): void {
  if (input.steps < 0 || input.steps > 200 || input.learningRate < 1e-6 || input.learningRate > 1e-3 || input.datasetSize < 1) {
    throw new DomainError("BUDGET_EXCEEDED", "The training configuration is outside the local budget", 422);
  }
  const sealed = new Set(input.sealedItemIds);
  for (const id of input.trainItemIds) {
    if (sealed.has(id)) {
      throw new DomainError("CONTAMINATED", "Training data contains a sealed evaluation item", 409);
    }
  }
}

export function planExperiments(input: { problem: string; history: ExperimentRecord[]; budgetMaxSteps: number; baseAccuracy: number | null }): PlanRecommendation[] {
  const risky = input.history.filter((record) => isHighRisk(record));
  const cited = risky.map((record) => record.id);
  const recommendations: PlanRecommendation[] = [];
  if (input.baseAccuracy !== null && input.baseAccuracy >= 0.9 && risky.length === 0) {
    recommendations.push({
      action: "no-weight-training",
      methodId: null,
      executable: false,
      reason: `${input.problem}: development accuracy is already ${input.baseAccuracy}. Weight updates are not the first recommendation.`,
      config: null,
      deployment: "ineligible",
      citedExperimentIds: [],
    });
  }
  if (risky.length > 0) {
    recommendations.push({
      action: "reject-configuration",
      methodId: "lora-supervised",
      executable: false,
      reason: "Historical runs with about 25 examples, 40 or more steps, and learning rate 0.0001 regressed the base model. That configuration is high-risk and is not proposed again.",
      config: { learningRate: 0.0001, steps: 80, datasetSize: 25, target: "answer" },
      deployment: "ineligible",
      citedExperimentIds: cited,
    });
  }
  const stepCap = Math.min(5, input.budgetMaxSteps);
  recommendations.push(
    {
      action: "zero-step-control",
      methodId: "lora-supervised",
      executable: stepCap >= 0,
      reason: "An initialized adapter with no optimizer steps checks whether loading LoRA weights changes answers before any update is blamed.",
      config: { learningRate: 0.00001, steps: 0, datasetSize: 25, target: "answer" },
      deployment: "ineligible",
      citedExperimentIds: cited,
    },
    {
      action: "smaller-update",
      methodId: "lora-supervised",
      executable: stepCap >= 5,
      reason: "Start at learning rate 1e-5 for 5 steps, two orders of magnitude less update budget than the M7.5 runs.",
      config: { learningRate: 0.00001, steps: 5, datasetSize: 25, target: "answer" },
      deployment: "ineligible",
      citedExperimentIds: cited,
    },
    {
      action: "more-data",
      methodId: "lora-supervised",
      executable: stepCap >= 5,
      reason: `A 250-example set at the same 5 steps has mean exposure ${meanExposures(5, 250).toFixed(3)}, versus ${meanExposures(5, 25).toFixed(3)} for 25 examples. Compare those exposures before claiming a dataset-size effect.`,
      config: { learningRate: 0.00001, steps: 5, datasetSize: 250, target: "answer" },
      deployment: "ineligible",
      citedExperimentIds: cited,
    },
    {
      action: "structured-target",
      methodId: "structured-solution-sft",
      executable: stepCap >= 5,
      reason: "Train on programmatically checked intermediate equations and still score the final integer. Do not train on unverified model reasoning.",
      config: { learningRate: 0.00001, steps: 5, datasetSize: 25, target: "structured" },
      deployment: "ineligible",
      citedExperimentIds: cited,
    },
    {
      action: "no-promotion",
      methodId: null,
      executable: false,
      reason: "A lower training loss, a development gain, or this plan does not authorize deployment. Evaluation and approval stay outside Weight Optimization.",
      config: null,
      deployment: "ineligible",
      citedExperimentIds: cited,
    },
  );
  return recommendations;
}

export function isHighRisk(record: ExperimentRecord): boolean {
  const observed = record.sealedAccuracy ?? record.devAccuracy;
  const baseline = record.baselineAccuracy;
  const regressed = observed !== null && baseline !== null && observed < baseline - 0.15;
  return record.datasetSize <= 40 && record.steps >= 40 && record.learningRate >= 0.0001 && regressed;
}

export function selectDevelopmentCandidate<T extends { id: string; devAccuracy: number; learningRate: number; steps: number; severe: boolean }>(candidates: T[]): T | null {
  const viable = candidates.filter((candidate) => !candidate.severe);
  const pool = viable.length > 0 ? viable : candidates;
  return [...pool].sort((left, right) => right.devAccuracy - left.devAccuracy || left.learningRate - right.learningRate || left.steps - right.steps || left.id.localeCompare(right.id))[0] ?? null;
}
