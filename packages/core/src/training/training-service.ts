import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  QWEN3_8B_MODEL_ID,
  trainingConfigSchema,
  type TrainingDatasetCreate,
  type TrainingRunCreate,
  type TrainableCheckpointRegister,
} from "@ai-colony/contracts";
import { snapshot, type RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { MessagingService } from "../messaging/message-service.js";
import type { Persistence } from "../ports/repositories.js";
import {
  ACCEPTANCE_CRITERIA,
  applyReserved,
  assertDisjoint,
  buildCuratedArithmetic,
  exampleFromMemory,
  exampleFromObjective,
  examplesFromSupplied,
  sha256Text,
  toMessagesJsonl,
  versionHash,
  type AssignedExample,
  type RejectedExample,
} from "./dataset.js";
import { meetsAcceptance, scoreOutputs, variability, type Score } from "./evaluate.js";
import { assertTrainableBuffer, inspectSafetensors, sha256File, writeInside } from "./files.js";
import { assertCheckpointPath, relativeToRoot } from "./paths.js";
import { frozenConfig, TRAINING_BUDGETS } from "./profiles.js";
import type { PredictJob, TrainingProvider } from "./provider.js";
import type { AdapterRecord, ArtifactRecord, CandidateRecord, DatasetVersionRecord, ExampleRecord, TrainableRecord, TrainingRunRecord } from "./repository.js";
import { assertNotSelfDecision, assertTrainingTransition } from "./transitions.js";

const ARTIFACT_FILES = {
  "adapter.weights": "float32-bin",
  "partial.weights": "float32-bin",
  "adapters.safetensors": "safetensors",
} as const;

export class TrainingService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly provider: TrainingProvider,
    private readonly messages: MessagingService,
    private readonly roots: { artifacts: string; checkpoints: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async registerCheckpoint(ctx: RequestContext, input: TrainableCheckpointRegister) {
    this.authorizer.assert(ctx.actor, "model:register");
    mkdirSync(this.roots.checkpoints, { recursive: true });
    const lexical = assertCheckpointPath(this.roots.checkpoints, input.checkpointPath);
    const sha256 = createHash("sha256").update(readFileSync(realpathSync(lexical))).digest("hex");
    if (sha256 !== input.expectedSha256) {
      throw new DomainError("ARTIFACT_MISMATCH", "Checkpoint bytes do not match the supplied checksum", 409);
    }
    const existing = await this.persistence.repos.training.findTrainableBySha(input.registryModelId, sha256);
    if (existing) {
      return this.publicCheckpoint(existing);
    }
    const model = await this.persistence.repos.models.findById(input.registryModelId);
    if (!model) {
      throw notFound("Model", input.registryModelId);
    }
    const identityMatches =
      model.modelFamily === "gemma-3" &&
      model.parameterCount === 270_000_000 &&
      input.framework === "mlx-lm" &&
      input.source.toLowerCase().includes("gemma") &&
      (input.architecture === "gemma3" || input.architecture === "gemma3_text");
    if (!identityMatches || model.id === QWEN3_8B_MODEL_ID) {
      throw new DomainError("NOT_ELIGIBLE", "Only a hashed Gemma 3 270M checkpoint can be trained. Qwen weights are not relabeled or trained here.", 409);
    }
    const record: TrainableRecord = {
      id: randomUUID(),
      registryModelId: model.id,
      displayName: model.displayName,
      modelFamily: model.modelFamily,
      source: input.source,
      revision: input.revision,
      parameterCount: model.parameterCount,
      precision: input.precision,
      architecture: input.architecture,
      tokenizerId: input.tokenizerId,
      contextLength: input.contextLength,
      framework: input.framework,
      frameworkVersion: input.frameworkVersion,
      artifactUri: lexical,
      sha256,
      license: input.license,
      availableLocally: true,
      eligibleForTraining: true,
      servingReady: false,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.transaction(async (repos) => {
      await repos.training.insertTrainable(record);
      await this.event(repos, ctx, { trainableModelId: record.id, eventType: "checkpoint.registered", detail: { sha256, family: model.modelFamily, servingReady: false } });
      await repos.audit.append({
        eventType: "checkpoint.registered",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "trainable_model",
        targetId: record.id,
        action: "checkpoint.registered",
        correlationId: ctx.correlationId,
        beforeState: { registryStatus: model.status, artifactUri: model.artifactUri },
        afterState: snapshot(this.publicCheckpoint(record)),
        metadata: { productionModelUnchanged: true },
      });
    });
    return this.publicCheckpoint(record);
  }

  async registry(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "training:read");
    const models = await this.persistence.repos.models.list({ limit: 50, cursor: null });
    const checkpoints = await this.persistence.repos.training.listTrainable();
    return {
      productionModelId: QWEN3_8B_MODEL_ID,
      note: "A registry row is not a local checkpoint, a trainable model, or a servable model. Those are separate flags.",
      models: models.data.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        modelFamily: model.modelFamily,
        status: model.status,
        artifactUri: model.artifactUri,
        trainableFlag: model.trainable,
      })),
      checkpoints: checkpoints.map((row) => this.publicCheckpoint(row)),
    };
  }

  async createDataset(ctx: RequestContext, input: TrainingDatasetCreate) {
    this.authorizer.assert(ctx.actor, "training:dataset:create");
    if (input.idempotencyKey) {
      const existing = await this.persistence.repos.training.findDatasetByKey(input.idempotencyKey);
      if (existing) {
        return this.datasetResponse(existing, [], []);
      }
    }
    const seed = input.seed;
    const reserved = new Set(await this.persistence.repos.training.listTestGroupKeys());
    const { accepted, rejected } = await this.collectExamples(input, seed);
    const rows = applyReserved(accepted, reserved);
    assertDisjoint(rows);
    const sealed = new Set(await this.persistence.repos.evaluation.sealedPromptHashes());
    if (rows.some((row) => row.split !== "test" && sealed.has(sha256Text(row.input.trim())))) {
      throw new DomainError("DATASET_LEAK", "A sealed evaluation item cannot enter a training split", 422);
    }
    const counts = countSplits(rows);
    if (counts.train < 1 || counts.validation < 1 || counts.test < 1) {
      throw new DomainError("DATASET_SPLIT", "A sealed dataset needs a train split, a validation split, and a held-out test split", 422);
    }
    if (rows.length > TRAINING_BUDGETS.maxExamples) {
      throw new DomainError("BUDGET_EXCEEDED", "The dataset exceeds the training example budget", 422);
    }
    const createdAt = this.now().toISOString();
    const datasetId = randomUUID();
    const versionId = randomUUID();
    const storedExamples = rows.map((row) => ({ ...row, id: randomUUID(), versionId }));
    const version: DatasetVersionRecord = {
      id: versionId,
      datasetId,
      name: input.name,
      taskDomain: input.taskDomain,
      version: 1,
      contentHash: versionHash(rows),
      splitSeed: seed,
      status: "sealed",
      trainCount: counts.train,
      validationCount: counts.validation,
      testCount: counts.test,
      criteria: ACCEPTANCE_CRITERIA,
      createdBy: ctx.actor.principalId,
      createdAt,
    };
    await this.persistence.transaction(async (repos) => {
      await repos.training.insertDataset({ id: datasetId, name: input.name, taskDomain: input.taskDomain, idempotencyKey: input.idempotencyKey ?? null, createdBy: ctx.actor.principalId, createdAt });
      await repos.training.insertVersion(version);
      await repos.training.insertExamples(storedExamples);
      await repos.audit.append({
        eventType: "dataset.sealed",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "training_dataset",
        targetId: version.id,
        action: "dataset.sealed",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { contentHash: version.contentHash, ...counts, criteria: ACCEPTANCE_CRITERIA },
        metadata: { rejected: rejected.length },
      });
    });
    return this.datasetResponse(version, storedExamples, rejected);
  }

  async listDatasets(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "training:dataset:read");
    const versions = await this.persistence.repos.training.listDatasets();
    return { data: await Promise.all(versions.map((version) => this.datasetResponse(version, [], []))) };
  }

  async getDataset(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:dataset:read");
    const direct = await this.persistence.repos.training.getVersion(id);
    const version = direct ?? (await this.persistence.repos.training.listDatasets()).find((row) => row.datasetId === id);
    if (!version) {
      throw notFound("Dataset version", id);
    }
    const examples = await this.persistence.repos.training.listExamples(version.id);
    return this.datasetResponse(version, examples, []);
  }

  async proposeRun(ctx: RequestContext, input: TrainingRunCreate) {
    this.authorizer.assert(ctx.actor, "training:propose");
    const existing = await this.persistence.repos.training.findRunByKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const trainable = await this.requireEligible(input.trainableModelId);
    const version = await this.requireVersion(input.datasetVersionId);
    const config = frozenConfig(input.seed ?? 7, version.contentHash, trainable.sha256);
    trainingConfigSchema.parse(config);
    const createdAt = this.now().toISOString();
    const run: TrainingRunRecord = {
      id: randomUUID(),
      datasetVersionId: version.id,
      trainableModelId: trainable.id,
      parentRunId: null,
      profile: config.profile,
      status: "awaiting_approval",
      idempotencyKey: input.idempotencyKey,
      seed: config.seed,
      attempt: 1,
      maxAttempts: TRAINING_BUDGETS.maxRetries + 1,
      config,
      approvedBy: null,
      approvedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequested: false,
      createdBy: ctx.actor.principalId,
      createdAt,
    };
    await this.persistence.transaction(async (repos) => {
      await repos.training.insertRun(run);
      await this.event(repos, ctx, { runId: run.id, trainableModelId: trainable.id, eventType: "training.proposed", detail: { profile: run.profile, datasetHash: version.contentHash } });
      await repos.audit.append({
        eventType: "training.proposed",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "training_run",
        targetId: run.id,
        action: "training.proposed",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: snapshot(run),
        metadata: { approvalRequired: true },
      });
    });
    await this.notifyProposal(ctx, run, trainable.registryModelId);
    return run;
  }

  async listRuns(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "training:read");
    return { data: await this.persistence.repos.training.listRuns() };
  }

  async getRun(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:read");
    return this.requireRun(id);
  }

  async approve(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:approve");
    const run = await this.requireRun(id);
    assertNotSelfDecision(ctx.actor, run.createdBy);
    assertTrainingTransition(run.status, "queued");
    const updated = await this.persistence.repos.training.updateRun(id, {
      status: "queued",
      approvedBy: ctx.actor.principalId,
      approvedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });
    await this.persistence.repos.audit.append({
      eventType: "training.approved",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "training_run",
      targetId: id,
      action: "training.approved",
      correlationId: ctx.correlationId,
      beforeState: { status: run.status },
      afterState: { status: "queued" },
      metadata: {},
    });
    return updated;
  }

  async cancel(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:cancel");
    const run = await this.requireRun(id);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new DomainError("INVALID_TRANSITION", `Cannot cancel a ${run.status} training run`, 409);
    }
    const cancelPath = join(this.roots.artifacts, "runs", id, "cancel");
    mkdirSync(join(this.roots.artifacts, "runs", id), { recursive: true });
    writeFileSync(cancelPath, "cancel");
    if (run.status === "queued" || run.status === "awaiting_approval" || run.status === "proposed") {
      assertTrainingTransition(run.status, "cancelled");
      return this.persistence.repos.training.updateRun(id, { status: "cancelled", cancelRequested: true, finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
    }
    return this.persistence.repos.training.updateRun(id, { cancelRequested: true, updatedAt: this.now().toISOString() });
  }

  async execute(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:execute");
    const current = await this.requireRun(id);
    assertNotSelfDecision(ctx.actor, current.createdBy);
    assertTrainingTransition(current.status, "preparing");
    const claimed = await this.persistence.transaction(async (repos) => repos.training.claimIfIdle(id, this.now().toISOString()));
    if (claimed === "busy") {
      throw new DomainError("BUDGET_EXCEEDED", "Only one training job can run at a time", 409);
    }
    if (claimed === "unavailable") {
      throw new DomainError("INVALID_TRANSITION", "The run is no longer queued", 409);
    }
    const trainable = await this.requireEligible(claimed.trainableModelId);
    const examples = await this.persistence.repos.training.listExamples(claimed.datasetVersionId);
    assertDisjoint(examples);
    const sealed = new Set(await this.persistence.repos.evaluation.sealedPromptHashes());
    const train = examples.filter((row) => row.split === "train");
    if (train.some((row) => sealed.has(sha256Text(row.input.trim())))) {
      throw new DomainError("DATASET_LEAK", "A sealed evaluation item is present in the training split", 422);
    }
    const validation = examples.filter((row) => row.split === "validation");
    if (train.some((row) => examples.some((other) => other.split === "test" && other.groupKey === row.groupKey))) {
      throw new DomainError("DATASET_LEAK", "A test group key is present in the training split", 422);
    }
    mkdirSync(join(this.roots.artifacts, "runs", id, "data"), { recursive: true });
    writeInside(this.roots.artifacts, `runs/${id}/data/train.jsonl`, toMessagesJsonl(train));
    writeInside(this.roots.artifacts, `runs/${id}/data/valid.jsonl`, toMessagesJsonl(validation));
    const before = this.checkpointSha(trainable.artifactUri);
    await this.persistence.repos.training.updateRun(id, { status: "training", updatedAt: this.now().toISOString() });
    await this.persistence.repos.objectives.heartbeat({ workerId: "training", role: "training", beatAt: this.now(), detail: this.provider.kind });
    try {
      const result = await this.provider.train(
        {
          runId: id,
          outputDir: join(this.roots.artifacts, "runs", id),
          dataDir: join(this.roots.artifacts, "runs", id, "data"),
          modelPath: this.modelDirectory(trainable.artifactUri),
          family: "gemma-3",
          learningRate: claimed.config.learningRate,
          steps: claimed.config.steps,
          seed: claimed.config.seed,
          rank: claimed.config.rank,
          scale: claimed.config.scale,
          dropout: claimed.config.dropout,
          batchSize: claimed.config.batchSize,
          gradAccum: claimed.config.gradAccum,
          maxSeq: claimed.config.maxSeq,
          numLayers: claimed.config.numLayers,
          targetModules: claimed.config.targetModules,
          cancelPath: join(this.roots.artifacts, "runs", id, "cancel"),
        },
        {
          metric: async (metric) => {
            await this.persistence.repos.training.insertMetric({ id: randomUUID(), runId: id, ...metric, recordedAt: this.now().toISOString() });
          },
          cancelled: async () => {
            const latest = await this.persistence.repos.training.findRun(id);
            return latest?.cancelRequested === true;
          },
        },
      );
      if (this.checkpointSha(trainable.artifactUri) !== before) {
        throw new DomainError("BASE_MUTATED", "The base checkpoint changed during training", 422);
      }
      if (result.cancelled) {
        await this.captureArtifacts(id, "checkpoint");
        return this.persistence.repos.training.updateRun(id, { status: "cancelled", finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
      }
      if (!result.artifactPath) {
        throw new DomainError("ARTIFACT_MISMATCH", "Training finished without an adapter artifact", 422);
      }
      const artifact = await this.storeArtifact(id, result.artifactPath, "adapter", { durationMs: result.durationMs, peakMemoryBytes: result.peakMemoryBytes, trainLoss: result.trainLoss, validationLoss: result.validationLoss });
      const adapter: AdapterRecord = {
        id: randomUUID(),
        artifactId: artifact.id,
        baseTrainableModelId: trainable.id,
        rank: claimed.config.rank,
        alpha: claimed.config.alpha,
        dropout: claimed.config.dropout,
        targetModules: claimed.config.targetModules,
        trainableParameters: Number(artifact.metadata.trainableParameters),
        framework: claimed.config.framework,
        createdAt: this.now().toISOString(),
      };
      const candidate: CandidateRecord = {
        id: randomUUID(),
        adapterId: adapter.id,
        runId: id,
        status: "experimental",
        createdBy: claimed.createdBy,
        createdAt: this.now().toISOString(),
      };
      await this.persistence.transaction(async (repos) => {
        await repos.training.insertAdapter(adapter);
        await repos.training.insertCandidate(candidate);
        await repos.training.updateRun(id, { status: "evaluating", updatedAt: this.now().toISOString() });
        await this.event(repos, ctx, { runId: id, candidateId: candidate.id, trainableModelId: trainable.id, eventType: "adapter.trained", detail: { sha256: artifact.sha256, trainableParameters: adapter.trainableParameters } });
      });
      return this.requireRun(id);
    } catch (error) {
      await this.captureArtifacts(id, "checkpoint");
      const message = error instanceof Error ? error.message : "training failed";
      await this.persistence.repos.training.updateRun(id, { status: "failed", error: message.slice(0, 2000), finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
      throw error;
    }
  }

  async retry(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:approve");
    const run = await this.requireRun(id);
    assertNotSelfDecision(ctx.actor, run.createdBy);
    assertTrainingTransition(run.status, "queued");
    if (run.attempt >= run.maxAttempts) {
      throw new DomainError("BUDGET_EXCEEDED", "The retry budget for this run is exhausted", 409);
    }
    return this.persistence.repos.training.updateRun(id, {
      status: "queued",
      attempt: run.attempt + 1,
      error: null,
      cancelRequested: false,
      finishedAt: null,
      updatedAt: this.now().toISOString(),
    });
  }

  async reproduce(ctx: RequestContext, id: string, idempotencyKey: string) {
    this.authorizer.assert(ctx.actor, "training:propose");
    const existing = await this.persistence.repos.training.findRunByKey(idempotencyKey);
    if (existing) {
      return existing;
    }
    const run = await this.requireRun(id);
    const copy: TrainingRunRecord = {
      ...run,
      id: randomUUID(),
      parentRunId: run.id,
      status: "awaiting_approval",
      idempotencyKey,
      attempt: 1,
      approvedBy: null,
      approvedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequested: false,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.training.insertRun(copy);
    return copy;
  }

  async metrics(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:read");
    await this.requireRun(id);
    return { data: await this.persistence.repos.training.listMetrics(id) };
  }

  async artifacts(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:read");
    await this.requireRun(id);
    const rows = await this.persistence.repos.training.listArtifacts(id);
    return {
      data: rows.map((row) => ({
        ...row,
        trainableParameters: Number(row.metadata.trainableParameters ?? 0),
      })),
    };
  }

  async evaluate(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "training:evaluate");
    const run = await this.requireRun(id);
    const candidate = await this.persistence.repos.training.findCandidateByRun(id);
    if (!candidate) {
      throw notFound("Candidate");
    }
    const existing = await this.persistence.repos.training.findEvaluation(candidate.id);
    if (existing) {
      return this.publicEvaluation(existing);
    }
    if (run.status !== "evaluating") {
      throw new DomainError("INVALID_TRANSITION", "Evaluation runs only after a stored adapter", 409);
    }
    const loaded = await this.loadCandidate(candidate.id);
    const examples = (await this.persistence.repos.training.listExamples(run.datasetVersionId)).filter((row) => row.split === "test");
    if (examples.length === 0) {
      throw new DomainError("DATASET_SPLIT", "The held-out test split is empty", 422);
    }
    const prompts = examples.map((row) => row.input);
    const expected = examples.map((row) => row.expectedOutput);
    const started = Date.now();
    const baselineOutputs = await this.predict(loaded, prompts, "baseline");
    const first = await this.predict(loaded, prompts, "candidate");
    const second = await this.predict(loaded, prompts, "candidate");
    const latencyMs = Date.now() - started;
    const baseline = scoreOutputs(expected, baselineOutputs, latencyMs, 0);
    const candidateScore = scoreOutputs(expected, first, latencyMs, variability(first, second));
    const acceptanceMet = meetsAcceptance(baseline, candidateScore, loaded.version.criteria);
    const qwen = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    const evaluation = {
      id: randomUUID(),
      candidateId: candidate.id,
      runId: id,
      baseline,
      candidate: candidateScore,
      acceptanceMet,
      criteria: loaded.version.criteria,
      report: {
        heldOut: examples.length,
        decoding: "greedy",
        lossIgnored: true,
        trainLoss: null,
        productionModel: qwen ? { id: qwen.id, status: qwen.status, artifactUri: qwen.artifactUri } : null,
        improvements: candidateScore.numericCorrectness - baseline.numericCorrectness,
        regressions: candidateScore.exactMatch < baseline.exactMatch,
      },
      createdAt: this.now().toISOString(),
    };
    await this.persistence.transaction(async (repos) => {
      await repos.training.insertEvaluation(evaluation);
      await repos.training.updateCandidate(candidate.id, acceptanceMet ? "experimental" : "rejected", this.now().toISOString());
      await repos.training.updateRun(id, { status: "completed", finishedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
      await repos.audit.append({
        eventType: "candidate.evaluated",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "model_candidate",
        targetId: candidate.id,
        action: "candidate.evaluated",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: { acceptanceMet, baseline: baseline.numericCorrectness, candidate: candidateScore.numericCorrectness },
        metadata: { lossIgnored: true },
      });
    });
    return this.publicEvaluation(evaluation);
  }

  async listCandidates(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "model:candidate:read");
    const rows = await this.persistence.repos.training.listCandidates();
    return { data: await Promise.all(rows.map((row) => this.publicCandidate(row))) };
  }

  async getCandidate(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "model:candidate:read");
    const candidate = await this.persistence.repos.training.findCandidate(id);
    if (!candidate) {
      throw notFound("Candidate", id);
    }
    const evaluation = await this.persistence.repos.training.findEvaluation(id);
    return { candidate: await this.publicCandidate(candidate), evaluation: evaluation ? this.publicEvaluation(evaluation) : null };
  }

  async requestPromotion(ctx: RequestContext, id: string, reason: string) {
    this.authorizer.assert(ctx.actor, "training:propose");
    const candidate = await this.persistence.repos.training.findCandidate(id);
    if (!candidate) {
      throw notFound("Candidate", id);
    }
    await this.persistence.repos.training.insertPromotion({
      id: randomUUID(),
      candidateId: id,
      status: "proposed",
      proposedBy: ctx.actor.principalId,
      decidedBy: null,
      reason,
      createdAt: this.now().toISOString(),
      decidedAt: null,
    });
    return { status: "proposed" as const };
  }

  async promote(ctx: RequestContext, id: string, reason: string) {
    this.authorizer.assert(ctx.actor, "model:candidate:promote");
    const loaded = await this.loadCandidate(id);
    assertNotSelfDecision(ctx.actor, loaded.candidate.createdBy);
    if (loaded.trainable.registryModelId === QWEN3_8B_MODEL_ID || loaded.trainable.modelFamily !== "gemma-3") {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Promotion cannot replace or relabel the production Qwen model", 409);
    }
    const evaluation = await this.persistence.repos.training.findEvaluation(id);
    if (!evaluation?.acceptanceMet) {
      throw new DomainError("ACCEPTANCE_FAILED", "A candidate is promoted only after a passing held-out comparison", 409);
    }
    this.verifyArtifact(loaded.artifact);
    if (await this.persistence.repos.evaluation.isArtifactContaminated(loaded.artifact.id)) {
      throw new DomainError("CONTAMINATED", "A contaminated adapter cannot be promoted until it is reviewed", 409);
    }
    const qwenBefore = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    await this.persistence.transaction(async (repos) => {
      await repos.training.updateCandidate(id, "approved", this.now().toISOString());
      await repos.training.insertPromotion({
        id: randomUUID(),
        candidateId: id,
        status: "approved",
        proposedBy: ctx.actor.principalId,
        decidedBy: ctx.actor.principalId,
        reason,
        createdAt: this.now().toISOString(),
        decidedAt: this.now().toISOString(),
      });
      await repos.audit.append({
        eventType: "candidate.promoted",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "model_candidate",
        targetId: id,
        action: "candidate.promoted",
        correlationId: ctx.correlationId,
        beforeState: { status: loaded.candidate.status, production: qwenBefore ? { status: qwenBefore.status, artifactUri: qwenBefore.artifactUri } : null },
        afterState: { status: "approved", experimentalOnly: true },
        metadata: { productionRoutingUnchanged: true },
      });
    });
    const qwenAfter = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    if (qwenBefore?.status !== qwenAfter?.status || qwenBefore?.artifactUri !== qwenAfter?.artifactUri) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Production model metadata changed during promotion", 422);
    }
    return this.publicCandidate({ ...loaded.candidate, status: "approved" });
  }

  async experimentalInfer(ctx: RequestContext, candidateId: string, prompt: string) {
    this.authorizer.assert(ctx.actor, "model:experimental:infer");
    const loaded = await this.loadCandidate(candidateId);
    if (loaded.candidate.status !== "approved") {
      throw new DomainError("NOT_APPROVED", "Experimental inference requires an approved candidate", 409);
    }
    if (loaded.trainable.modelFamily !== "gemma-3" || loaded.trainable.registryModelId === QWEN3_8B_MODEL_ID) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Candidate inference cannot use the production Qwen model", 409);
    }
    this.verifyArtifact(loaded.artifact);
    const [output] = await this.predict(loaded, [prompt], "candidate");
    return {
      output: output ?? "",
      baseModelId: loaded.trainable.registryModelId,
      baseFamily: loaded.trainable.modelFamily,
      adapterId: loaded.adapter.id,
      adapterSha256: loaded.artifact.sha256,
      framework: this.provider.kind,
      loadedAdapter: true as const,
      decoding: "greedy" as const,
      productionModelId: QWEN3_8B_MODEL_ID,
      usedProductionModel: false as const,
    };
  }

  async health(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "training:read");
    const ready = await this.provider.ready();
    await this.persistence.repos.objectives.heartbeat({ workerId: "training", role: "training", beatAt: this.now(), detail: this.provider.kind });
    return { provider: this.provider.kind, ready: ready.ready, productionModelId: QWEN3_8B_MODEL_ID, productionIsolated: true as const, detail: ready.detail };
  }

  async recoverInterrupted(): Promise<string[]> {
    const rows = await this.persistence.repos.training.listActiveJobs();
    const recovered: string[] = [];
    for (const row of rows) {
      await this.persistence.repos.training.updateRun(row.id, {
        status: row.cancelRequested ? "cancelled" : "failed",
        error: row.cancelRequested ? row.error : "worker_lost: not restarted automatically",
        finishedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      });
      recovered.push(row.id);
    }
    return recovered;
  }

  private async collectExamples(input: TrainingDatasetCreate, seed: number): Promise<{ accepted: AssignedExample[]; rejected: RejectedExample[] }> {
    if (input.source === "curated_arithmetic") {
      return { accepted: buildCuratedArithmetic(input.exampleCount ?? 48, seed), rejected: [] };
    }
    if (input.source === "supplied") {
      return examplesFromSupplied((input.examples ?? []).map((row) => row.input), seed);
    }
    if (input.source === "memories") {
      const accepted: AssignedExample[] = [];
      const rejected: RejectedExample[] = [];
      for (const id of input.memoryIds ?? []) {
        const memory = await this.persistence.repos.memories.findById(id);
        if (!memory) {
          rejected.push({ input: id, reason: "missing" });
          continue;
        }
        const result = exampleFromMemory(memory, seed);
        if ("rejected" in result) {
          rejected.push(result.rejected);
        } else {
          accepted.push(result.example);
        }
      }
      return { accepted, rejected };
    }
    const accepted: AssignedExample[] = [];
    const rejected: RejectedExample[] = [];
    const seen = new Set<string>();
    for (const row of input.examples ?? []) {
      if (!row.sourceObjectiveId) {
        rejected.push({ input: row.input, reason: "missing_objective" });
        continue;
      }
      const objective = await this.persistence.repos.objectives.getRun(row.sourceObjectiveId);
      if (!objective) {
        rejected.push({ input: row.input, reason: "missing_objective" });
        continue;
      }
      const result = exampleFromObjective(objective, row.input, seed);
      if ("rejected" in result) {
        rejected.push(result.rejected);
        continue;
      }
      if (seen.has(result.example.groupKey)) {
        rejected.push({ input: row.input, reason: "near_duplicate" });
        continue;
      }
      seen.add(result.example.groupKey);
      accepted.push(result.example);
    }
    return { accepted, rejected };
  }

  private async predict(loaded: LoadedCandidate, prompts: string[], mode: PredictJob["mode"]): Promise<string[]> {
    const outputDir = join(this.roots.artifacts, "runs", loaded.candidate.runId, `predict-${mode}-${randomUUID()}`);
    mkdirSync(outputDir, { recursive: true });
    return this.provider.predict({
      mode,
      prompts,
      modelPath: this.modelDirectory(loaded.trainable.artifactUri),
      adapterPath: mode === "candidate" ? this.absoluteArtifact(loaded.artifact) : null,
      expectedAdapterSha256: mode === "candidate" ? loaded.artifact.sha256 : null,
      artifactRoot: this.roots.artifacts,
      outputDir,
    });
  }

  private async loadCandidate(id: string): Promise<LoadedCandidate> {
    const candidate = await this.persistence.repos.training.findCandidate(id);
    if (!candidate) {
      throw notFound("Candidate", id);
    }
    const adapter = await this.persistence.repos.training.findAdapter(candidate.adapterId);
    if (!adapter) {
      throw notFound("Adapter", candidate.adapterId);
    }
    const artifacts = await this.persistence.repos.training.listArtifacts(candidate.runId);
    const artifact = artifacts.find((row) => row.id === adapter.artifactId);
    if (!artifact) {
      throw notFound("Artifact", adapter.artifactId);
    }
    const trainable = await this.requireEligible(adapter.baseTrainableModelId);
    const run = await this.requireRun(candidate.runId);
    const version = await this.requireVersion(run.datasetVersionId);
    if (trainable.modelFamily !== "gemma-3") {
      throw new DomainError("ADAPTER_INCOMPATIBLE", "The adapter base is not Gemma 3", 409);
    }
    return { candidate, adapter, artifact, trainable, version };
  }

  private verifyArtifact(artifact: ArtifactRecord): void {
    const absolute = this.absoluteArtifact(artifact);
    const actual = sha256File(this.roots.artifacts, absolute);
    if (actual !== artifact.sha256) {
      throw new DomainError("ARTIFACT_MISMATCH", "Stored adapter bytes no longer match the recorded checksum", 409);
    }
  }

  private async storeArtifact(runId: string, absolute: string, kind: ArtifactRecord["kind"], metadata: Record<string, unknown>): Promise<ArtifactRecord> {
    const name = absolute.split("/").pop() ?? "";
    const format = ARTIFACT_FILES[name as keyof typeof ARTIFACT_FILES];
    if (!format) {
      throw new DomainError("ARTIFACT_PATH_REJECTED", "Artifact filename is not allowlisted", 400);
    }
    const bytes = readFileSync(absolute);
    const trainableParameters = format === "safetensors" ? inspectSafetensors(bytes).parameters : Math.floor(assertTrainableBuffer(bytes));
    const sha256 = sha256File(this.roots.artifacts, absolute);
    const used = await this.persistence.repos.training.artifactBytes();
    if (used + bytes.length > TRAINING_BUDGETS.maxArtifactBytes) {
      throw new DomainError("BUDGET_EXCEEDED", "The artifact storage budget is exhausted", 422);
    }
    const record: ArtifactRecord = {
      id: randomUUID(),
      runId,
      kind,
      relativePath: relativeToRoot(this.roots.artifacts, absolute),
      sha256,
      byteSize: bytes.length,
      format,
      metadata: { ...metadata, trainableParameters },
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.training.insertArtifact(record);
    return record;
  }

  private async captureArtifacts(runId: string, kind: ArtifactRecord["kind"]): Promise<void> {
    const directory = join(this.roots.artifacts, "runs", runId);
    let names: string[] = [];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    const existing = new Set((await this.persistence.repos.training.listArtifacts(runId)).map((row) => row.relativePath));
    for (const name of names) {
      if (!(name in ARTIFACT_FILES)) {
        continue;
      }
      const relativePath = `runs/${runId}/${name}`;
      if (existing.has(relativePath)) {
        continue;
      }
      try {
        await this.storeArtifact(runId, join(directory, name), kind, { partial: true });
      } catch {
        // A partial file that fails inspection stays on disk and is reported by the run error.
      }
    }
  }

  private modelDirectory(artifactUri: string): string {
    return statSync(artifactUri).isDirectory() ? artifactUri : dirname(artifactUri);
  }

  private checkpointSha(artifactUri: string): string {
    return createHash("sha256").update(readFileSync(realpathSync(artifactUri))).digest("hex");
  }

  private absoluteArtifact(artifact: ArtifactRecord): string {
    return join(this.roots.artifacts, artifact.relativePath);
  }

  private publicCheckpoint(record: TrainableRecord) {
    return {
      id: record.id,
      registryModelId: record.registryModelId,
      displayName: record.displayName,
      modelFamily: record.modelFamily,
      source: record.source,
      revision: record.revision,
      parameterCount: record.parameterCount,
      precision: record.precision,
      architecture: record.architecture,
      tokenizerId: record.tokenizerId,
      contextLength: record.contextLength,
      framework: record.framework,
      frameworkVersion: record.frameworkVersion,
      relativePath: relativeToRoot(this.roots.checkpoints, record.artifactUri),
      sha256: record.sha256,
      license: record.license,
      availableLocally: record.availableLocally,
      eligibleForTraining: record.eligibleForTraining,
      servingReady: record.servingReady,
      createdAt: record.createdAt,
    };
  }

  private async datasetResponse(version: DatasetVersionRecord, examples: ExampleRecord[], rejected: RejectedExample[]) {
    const stored = examples.length > 0 ? examples : await this.persistence.repos.training.listExamples(version.id);
    const forgotten = new Set<string>();
    for (const row of stored) {
      if (!row.sourceMemoryId) {
        continue;
      }
      const memory = await this.persistence.repos.memories.findById(row.sourceMemoryId);
      if (memory?.status === "forgotten") {
        forgotten.add(row.sourceMemoryId);
      }
    }
    return {
      id: version.datasetId,
      name: version.name,
      taskDomain: version.taskDomain,
      versionId: version.id,
      version: version.version,
      contentHash: version.contentHash,
      splitSeed: version.splitSeed,
      status: version.status,
      trainCount: version.trainCount,
      validationCount: version.validationCount,
      testCount: version.testCount,
      criteria: version.criteria,
      rejected,
      examples: stored.map((row) => ({
        id: row.id,
        split: row.split,
        groupKey: row.groupKey,
        source: row.source,
        license: row.license,
        input: row.sourceMemoryId && forgotten.has(row.sourceMemoryId) ? "[forgotten]" : row.input,
        expectedOutput: row.sourceMemoryId && forgotten.has(row.sourceMemoryId) ? "[forgotten]" : row.expectedOutput,
        validationStatus: row.validationStatus,
        sourceMemoryId: row.sourceMemoryId,
        sourceObjectiveId: row.sourceObjectiveId,
        contentHash: row.contentHash,
      })),
      createdAt: version.createdAt,
    };
  }

  private async publicCandidate(candidate: CandidateRecord) {
    const loaded = await this.loadCandidate(candidate.id);
    return {
      id: candidate.id,
      runId: candidate.runId,
      adapterId: candidate.adapterId,
      status: candidate.status,
      baseModelId: loaded.trainable.registryModelId,
      baseFamily: loaded.trainable.modelFamily,
      adapterSha256: loaded.artifact.sha256,
      trainableParameters: loaded.adapter.trainableParameters,
      createdAt: candidate.createdAt,
    };
  }

  private publicEvaluation(evaluation: { id: string; candidateId: string; runId: string; acceptanceMet: boolean; criteria: DatasetVersionRecord["criteria"]; baseline: Record<string, unknown> | Score; candidate: Record<string, unknown> | Score; report: Record<string, unknown>; createdAt: string }) {
    return {
      id: evaluation.id,
      candidateId: evaluation.candidateId,
      runId: evaluation.runId,
      acceptanceMet: evaluation.acceptanceMet,
      criteria: evaluation.criteria,
      baseline: evaluation.baseline as Score,
      candidate: evaluation.candidate as Score,
      report: evaluation.report,
      createdAt: evaluation.createdAt,
    };
  }

  private async requireRun(id: string): Promise<TrainingRunRecord> {
    const run = await this.persistence.repos.training.findRun(id);
    if (!run) {
      throw notFound("Training run", id);
    }
    return run;
  }

  private async requireVersion(id: string): Promise<DatasetVersionRecord> {
    const version = await this.persistence.repos.training.getVersion(id);
    if (!version) {
      throw notFound("Dataset version", id);
    }
    return version;
  }

  private async requireEligible(id: string): Promise<TrainableRecord> {
    const trainable = await this.persistence.repos.training.findTrainable(id);
    if (!trainable) {
      throw notFound("Trainable checkpoint", id);
    }
    if (!trainable.availableLocally || !trainable.eligibleForTraining || trainable.servingReady) {
      throw new DomainError("NOT_ELIGIBLE", "Checkpoint metadata is not enough. The file must be present, hashed, and eligible, and it is not production-serving.", 409);
    }
    if (this.checkpointSha(trainable.artifactUri) !== trainable.sha256) {
      throw new DomainError("ARTIFACT_MISMATCH", "The local checkpoint no longer matches its registered checksum", 409);
    }
    return trainable;
  }

  private async notifyProposal(ctx: RequestContext, run: TrainingRunRecord, registryModelId: string): Promise<void> {
    if (!ctx.actor.agentId || !ctx.actor.departmentId) {
      return;
    }
    try {
      await this.messages.send(ctx, {
        messageType: "TRAINING_REQUEST",
        recipientDepartmentId: ctx.actor.departmentId,
        priority: 5,
        idempotencyKey: `train.${run.id}`,
        payload: {
          targetModelId: registryModelId,
          learningObjective: "Structured arithmetic adaptation. This message does not launch training.",
          datasetReference: run.datasetVersionId,
          trainingConstraints: { maxParameterCount: 270_000_000, notes: "Do not launch training" },
          evaluationRequirements: ["Held-out numeric correctness must improve. Training loss is not acceptance."],
        },
      });
    } catch {
      // The run remains the source of truth when the notification cannot be queued.
    }
  }

  private async event(
    repos: Persistence["repos"],
    ctx: RequestContext,
    input: { trainableModelId?: string; candidateId?: string; runId?: string; eventType: string; detail: Record<string, unknown> },
  ): Promise<void> {
    await repos.training.insertEvent({
      id: randomUUID(),
      trainableModelId: input.trainableModelId ?? null,
      candidateId: input.candidateId ?? null,
      runId: input.runId ?? null,
      eventType: input.eventType,
      actorId: ctx.actor.principalId,
      detail: input.detail,
      createdAt: this.now().toISOString(),
    });
  }
}

interface LoadedCandidate {
  candidate: CandidateRecord;
  adapter: AdapterRecord;
  artifact: ArtifactRecord;
  trainable: TrainableRecord;
  version: DatasetVersionRecord;
}

function countSplits(rows: AssignedExample[]): { train: number; validation: number; test: number } {
  return {
    train: rows.filter((row) => row.split === "train").length,
    validation: rows.filter((row) => row.split === "validation").length,
    test: rows.filter((row) => row.split === "test").length,
  };
}
