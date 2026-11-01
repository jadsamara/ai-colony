import type { AcceptanceCriteria, TrainingConfig, TrainingRunStatus } from "@ai-colony/contracts";
import type { AssignedExample, ExampleSource, ExampleSplit } from "./dataset.js";
import type { Score } from "./evaluate.js";

export interface TrainableRecord {
  id: string;
  registryModelId: string;
  displayName: string;
  modelFamily: string;
  source: string;
  revision: string;
  parameterCount: number;
  precision: string;
  architecture: string;
  tokenizerId: string;
  contextLength: number;
  framework: string;
  frameworkVersion: string;
  artifactUri: string;
  sha256: string;
  license: string;
  availableLocally: boolean;
  eligibleForTraining: boolean;
  servingReady: boolean;
  createdAt: string;
}

export interface DatasetVersionRecord {
  id: string;
  datasetId: string;
  name: string;
  taskDomain: string;
  version: number;
  contentHash: string;
  splitSeed: number;
  status: "sealed";
  trainCount: number;
  validationCount: number;
  testCount: number;
  criteria: AcceptanceCriteria;
  createdBy: string;
  createdAt: string;
}

export interface ExampleRecord extends AssignedExample {
  id: string;
  versionId: string;
}

export interface TrainingRunRecord {
  id: string;
  datasetVersionId: string;
  trainableModelId: string;
  parentRunId: string | null;
  profile: TrainingConfig["profile"];
  status: TrainingRunStatus;
  idempotencyKey: string;
  seed: number;
  attempt: number;
  maxAttempts: number;
  config: TrainingConfig;
  approvedBy: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
  createdBy: string;
  createdAt: string;
}

export interface MetricRecord {
  step: number;
  trainLoss: number | null;
  validationLoss: number | null;
  learningRate: number | null;
  recordedAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  kind: "adapter" | "checkpoint";
  relativePath: string;
  sha256: string;
  byteSize: number;
  format: "safetensors" | "float32-bin";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdapterRecord {
  id: string;
  artifactId: string;
  baseTrainableModelId: string;
  rank: number;
  alpha: number;
  dropout: number;
  targetModules: string[];
  trainableParameters: number;
  framework: string;
  createdAt: string;
}

export interface CandidateRecord {
  id: string;
  adapterId: string;
  runId: string;
  status: "experimental" | "rejected" | "approved" | "retired" | "revoked" | "quarantined";
  createdBy: string;
  createdAt: string;
}

export interface EvaluationRecord {
  id: string;
  candidateId: string;
  runId: string;
  baseline: Score;
  candidate: Score;
  acceptanceMet: boolean;
  criteria: AcceptanceCriteria;
  report: Record<string, unknown>;
  createdAt: string;
}

export interface PromotionRecord {
  id: string;
  candidateId: string;
  status: "proposed" | "approved" | "rejected";
  proposedBy: string;
  decidedBy: string | null;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface TrainingSummary {
  queued: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  datasets: number;
  examples: number;
  artifactBytes: number;
  candidatesApproved: number;
  candidatesRejected: number;
}

export interface NewExample extends AssignedExample {
  id: string;
  versionId: string;
  source: ExampleSource;
  split: ExampleSplit;
}

export interface TrainingRepository {
  insertTrainable(input: TrainableRecord): Promise<void>;
  findTrainable(id: string): Promise<TrainableRecord | null>;
  findTrainableBySha(registryModelId: string, sha256: string): Promise<TrainableRecord | null>;
  listTrainable(): Promise<TrainableRecord[]>;
  findDatasetByKey(key: string): Promise<DatasetVersionRecord | null>;
  insertDataset(input: { id: string; name: string; taskDomain: string; idempotencyKey: string | null; createdBy: string; createdAt: string }): Promise<void>;
  insertVersion(input: DatasetVersionRecord): Promise<void>;
  insertExamples(rows: NewExample[]): Promise<void>;
  getVersion(id: string): Promise<DatasetVersionRecord | null>;
  listExamples(versionId: string): Promise<ExampleRecord[]>;
  listDatasets(): Promise<DatasetVersionRecord[]>;
  listTestGroupKeys(): Promise<string[]>;
  insertRun(input: TrainingRunRecord): Promise<void>;
  findRun(id: string): Promise<TrainingRunRecord | null>;
  findRunByKey(key: string): Promise<TrainingRunRecord | null>;
  listRuns(): Promise<TrainingRunRecord[]>;
  updateRun(id: string, patch: Partial<{ status: TrainingRunStatus; error: string | null; cancelRequested: boolean; approvedBy: string | null; approvedAt: string | null; startedAt: string | null; finishedAt: string | null; attempt: number; updatedAt: string }>): Promise<TrainingRunRecord>;
  claimIfIdle(id: string, at: string): Promise<"busy" | "unavailable" | TrainingRunRecord>;
  listActiveJobs(): Promise<TrainingRunRecord[]>;
  insertMetric(input: { id: string; runId: string; step: number; trainLoss: number | null; validationLoss: number | null; learningRate: number | null; recordedAt: string }): Promise<void>;
  listMetrics(runId: string): Promise<MetricRecord[]>;
  insertArtifact(input: ArtifactRecord): Promise<void>;
  listArtifacts(runId: string): Promise<ArtifactRecord[]>;
  artifactBytes(): Promise<number>;
  insertAdapter(input: AdapterRecord): Promise<void>;
  findAdapter(id: string): Promise<AdapterRecord | null>;
  insertCandidate(input: CandidateRecord): Promise<void>;
  findCandidate(id: string): Promise<CandidateRecord | null>;
  findCandidateByRun(runId: string): Promise<CandidateRecord | null>;
  listCandidates(): Promise<CandidateRecord[]>;
  updateCandidate(id: string, status: CandidateRecord["status"], at: string): Promise<void>;
  insertEvaluation(input: EvaluationRecord): Promise<void>;
  findEvaluation(candidateId: string): Promise<EvaluationRecord | null>;
  insertPromotion(input: PromotionRecord): Promise<void>;
  summary(): Promise<TrainingSummary>;
  insertEvent(input: { id: string; trainableModelId: string | null; candidateId: string | null; runId: string | null; eventType: string; actorId: string; detail: Record<string, unknown>; createdAt: string }): Promise<void>;
}
