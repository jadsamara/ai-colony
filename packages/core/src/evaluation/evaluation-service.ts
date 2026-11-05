import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import type { RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { MessagingService } from "../messaging/message-service.js";
import type { Persistence } from "../ports/repositories.js";
import { sha256Text } from "../training/dataset.js";
import { sha256File } from "../training/files.js";
import type { TrainingProvider } from "../training/provider.js";
import { assertNotSelfDecision } from "../training/transitions.js";
import { colonyRunContract, legacyManifest, readStoredContract } from "./colony-manifest.js";
import { compareManifests } from "./compare.js";
import { parseEvaluationManifest } from "./manifest.js";
import { analyzePairedRuns, type AlignedItem } from "./paired.js";
import { applyGateIfComparable, decideGate, GATE_POLICY, gatePolicyHash } from "./gate.js";
import { gradeArithmetic } from "./score.js";
import { claimSignificance, mcnemarExact, pairedCounts, wilsonInterval } from "./stats.js";

const SCORER = { id: "arithmetic", version: "m6-equation-v1" };
const PROMPT_TEMPLATE = "answer the arithmetic task";

export class EvaluationService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly provider: TrainingProvider,
    private readonly messages: MessagingService,
    private readonly roots: { artifacts: string; checkpoints: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createSuite(ctx: RequestContext, input: { slug: string; name: string }) {
    this.authorizer.assert(ctx.actor, "evaluation:suite:create");
    const existing = await this.persistence.repos.evaluation.findSuiteBySlug(input.slug);
    if (existing) {
      return existing;
    }
    const suite = { id: randomUUID(), slug: input.slug, name: input.name, createdBy: ctx.actor.principalId, createdAt: this.now().toISOString() };
    await this.persistence.repos.evaluation.insertSuite(suite);
    return suite;
  }

  async addVersion(
    ctx: RequestContext,
    suiteId: string,
    input: { description: string; domain: string; source: string; license: string; protocol: string; sealed: boolean; items: Array<{ prompt: string; expected: string }> },
  ) {
    this.authorizer.assert(ctx.actor, "evaluation:suite:create");
    const suite = await this.persistence.repos.evaluation.findSuite(suiteId);
    if (!suite) {
      throw notFound("Benchmark suite", suiteId);
    }
    if (input.items.length < 1 || input.items.length > 64) {
      throw new DomainError("DATASET_SPLIT", "A benchmark version needs between 1 and 64 items", 422);
    }
    const versions = await this.persistence.repos.evaluation.listVersions(suiteId);
    const items = input.items.map((item, ordinal) => ({
      id: randomUUID(),
      versionId: "",
      ordinal,
      domain: input.domain,
      prompt: item.prompt.trim(),
      expected: item.expected.trim(),
      promptHash: sha256Text(item.prompt.trim()),
      sealed: input.sealed,
    }));
    const contentHash = sha256Text(items.map((item) => `${item.ordinal}\n${item.promptHash}\n${item.expected}`).join("\n"));
    const versionId = randomUUID();
    const version = {
      id: versionId,
      suiteId,
      version: versions.length + 1,
      description: input.description,
      domain: input.domain,
      source: input.source,
      license: input.license,
      protocol: input.protocol,
      scorerId: SCORER.id,
      scorerVersion: SCORER.version,
      contentHash,
      promptTemplateHash: sha256Text(PROMPT_TEMPLATE),
      decoding: { temperature: 0, maxTokens: 8, strategy: "greedy" },
      thresholds: { ...GATE_POLICY },
      status: "draft" as const,
      sealed: input.sealed,
      createdBy: ctx.actor.principalId,
      approvedBy: null,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.transaction(async (repos) => {
      await repos.evaluation.insertVersion(version);
      await repos.evaluation.insertItems(items.map((item) => ({ ...item, versionId })));
    });
    return this.publicVersion(version, false);
  }

  async publishVersion(ctx: RequestContext, versionId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:suite:approve");
    const version = await this.requireVersion(versionId);
    assertNotSelfDecision(ctx.actor, version.createdBy);
    if (version.status !== "draft") {
      throw new DomainError("INVALID_STATE", "Only a draft benchmark version can be published", 409);
    }
    await this.persistence.repos.evaluation.publishVersion(versionId, ctx.actor.principalId);
    return { id: versionId, status: "published" as const, contentHash: version.contentHash };
  }

  async listSuites(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    return { data: await this.persistence.repos.evaluation.listSuites() };
  }

  async getVersion(ctx: RequestContext, versionId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    const version = await this.requireVersion(versionId);
    const reveal = !version.sealed || (await this.canReadSealed(ctx));
    const items = reveal ? await this.persistence.repos.evaluation.listItems(versionId) : [];
    return this.publicVersion(version, reveal, items);
  }

  async run(
    ctx: RequestContext,
    input: { versionId: string; candidateId: string; source: "live" | "historical"; baselineOutputs?: string[]; candidateOutputs?: string[] },
  ) {
    this.authorizer.assert(ctx.actor, "evaluation:run");
    const version = await this.requireVersion(input.versionId);
    if (version.status !== "published") {
      throw new DomainError("INVALID_STATE", "Evaluation requires a published benchmark version", 409);
    }
    if (version.sealed && !(await this.canReadSealed(ctx))) {
      throw new DomainError("AUTHORIZATION_DENIED", "Sealed benchmark content is limited to the evaluation department", 403);
    }
    const items = await this.persistence.repos.evaluation.listItems(version.id);
    const loaded = await this.loadCandidate(input.candidateId);
    const baseSha = this.fileSha(loaded.trainable.artifactUri);
    const adapterSha = sha256File(this.roots.artifacts, join(this.roots.artifacts, loaded.artifact.relativePath));
    if (baseSha !== loaded.trainable.sha256 || adapterSha !== loaded.artifact.sha256) {
      throw new DomainError("ARTIFACT_MISMATCH", "The checkpoint or adapter no longer matches its recorded checksum", 409);
    }
    let baselineOutputs = input.baselineOutputs ?? [];
    let candidateOutputs = input.candidateOutputs ?? [];
    if (input.source === "live") {
      const prompts = items.map((item) => item.prompt);
      baselineOutputs = await this.predict(loaded, prompts, "baseline");
      candidateOutputs = await this.predict(loaded, prompts, "candidate");
    }
    if (baselineOutputs.length !== items.length || candidateOutputs.length !== items.length) {
      throw new DomainError("EVALUATION_FAILED", "Baseline and candidate outputs must cover every benchmark item", 422);
    }
    const graded = items.map((item, index) => ({
      ordinal: item.ordinal,
      expected: item.expected,
      baseline: gradeArithmetic(item.expected, baselineOutputs[index] ?? ""),
      candidate: gradeArithmetic(item.expected, candidateOutputs[index] ?? ""),
      baselineRaw: baselineOutputs[index] ?? "",
      candidateRaw: candidateOutputs[index] ?? "",
    }));
    const paired = pairedCounts(
      graded.map((row) => row.baseline.taskCorrect),
      graded.map((row) => row.candidate.taskCorrect),
    );
    const pValue = mcnemarExact(paired.baselineOnly, paired.candidateOnly);
    const summary = {
      scorerId: SCORER.id,
      scorerVersion: SCORER.version,
      benchmarkVersionId: version.id,
      contentHash: version.contentHash,
      sampleSize: paired.sampleSize,
      strictBaseline: rate(graded.map((row) => row.baseline.strictIntegerMatch)),
      strictCandidate: rate(graded.map((row) => row.candidate.strictIntegerMatch)),
      taskBaseline: paired.baselineAccuracy,
      taskCandidate: paired.candidateAccuracy,
      formatBaseline: rate(graded.map((row) => row.baseline.formatValid)),
      formatCandidate: rate(graded.map((row) => row.candidate.formatValid)),
      paired,
      wilsonBaseline: wilsonInterval(paired.bothCorrect + paired.baselineOnly, paired.sampleSize),
      wilsonCandidate: wilsonInterval(paired.bothCorrect + paired.candidateOnly, paired.sampleSize),
      pValue,
      claimSignificance: claimSignificance(paired.sampleSize, GATE_POLICY.minSampleForPass, pValue),
      baseSha256: baseSha,
      adapterSha256: adapterSha,
      candidateId: loaded.candidate.id,
      framework: this.provider.kind,
      decoding: version.decoding,
      productionModelId: QWEN3_8B_MODEL_ID,
      historicalM5RowPreserved: true,
    };
    const runId = randomUUID();
    const maxOutputTokens = numberField(version.decoding.maxTokens);
    const temperature = numberField(version.decoding.temperature);
    if (maxOutputTokens === null || temperature === null || loaded.trainable.contextLength < 1 || loaded.trainable.precision.length < 1) {
      throw new DomainError("EVALUATION_FAILED", "The benchmark or checkpoint is missing a recorded evaluation setting", 422);
    }
    const contract = colonyRunContract({
      runId,
      recordedAt: this.now().toISOString(),
      family: loaded.trainable.modelFamily,
      identifier: loaded.trainable.revision,
      alias: loaded.trainable.displayName,
      checkpointId: loaded.trainable.id,
      checkpointDigest: baseSha,
      adapterId: loaded.adapter.id,
      adapterVersion: `rank-${loaded.adapter.rank}`,
      adapterDigest: adapterSha,
      quantization: loaded.trainable.precision,
      backendId: loaded.trainable.framework,
      backendVersion: loaded.trainable.frameworkVersion,
      benchmarkId: version.suiteId,
      benchmarkVersion: String(version.version),
      itemSetFingerprint: version.contentHash,
      itemCount: items.length,
      promptTemplateDigest: version.promptTemplateHash,
      scorerId: version.scorerId,
      scorerVersion: version.scorerVersion,
      maxOutputTokens,
      temperature,
      contextWindow: loaded.trainable.contextLength,
    });
    const summaryWithContract = { ...summary, contract };
    const reportId = randomUUID();
    const createdAt = this.now().toISOString();
    await this.persistence.transaction(async (repos) => {
      await repos.evaluation.insertRun({
        id: runId,
        benchmarkVersionId: version.id,
        candidateId: loaded.candidate.id,
        trainableModelId: loaded.trainable.id,
        baseSha256: baseSha,
        adapterSha256: adapterSha,
        source: input.source,
        status: "completed",
        decoding: { ...version.decoding, evaluationContract: { baseline: contract.baseline, candidate: contract.candidate } },
        createdBy: ctx.actor.principalId,
        error: null,
        createdAt,
        finishedAt: createdAt,
      });
      await repos.evaluation.insertResults(
        graded.flatMap((row) => [
          resultRow(runId, row.ordinal, "baseline", row.baselineRaw, row.baseline),
          resultRow(runId, row.ordinal, "candidate", row.candidateRaw, row.candidate),
        ]),
      );
      await repos.evaluation.insertReport({ id: reportId, runId, summary: summaryWithContract, createdAt });
    });
    await this.notify(ctx, loaded.candidate.id, "inconclusive", summary.taskCandidate - summary.taskBaseline);
    return { runId, reportId, summary: summaryWithContract };
  }

  async getReport(ctx: RequestContext, runId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    const report = await this.persistence.repos.evaluation.findReportByRun(runId);
    const run = await this.persistence.repos.evaluation.findRun(runId);
    if (!report || !run) {
      throw notFound("Evaluation report", runId);
    }
    const version = await this.requireVersion(run.benchmarkVersionId);
    const reveal = !version.sealed || (await this.canReadSealed(ctx));
    const results = await this.persistence.repos.evaluation.listResults(runId);
    return {
      id: report.id,
      runId,
      source: run.source,
      sealed: version.sealed,
      summary: report.summary,
      items: reveal
        ? results
        : results.map((row) => ({ ordinal: row.ordinal, role: row.role, taskCorrect: row.taskCorrect, formatValid: row.formatValid, strictIntegerMatch: row.strictIntegerMatch, ambiguous: row.ambiguous })),
    };
  }

  async compare(
    ctx: RequestContext,
    input: { baseline: unknown; candidate: unknown; items?: AlignedItem[] },
  ) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    try {
      const baseline = parseEvaluationManifest(input.baseline);
      const candidate = parseEvaluationManifest(input.candidate);
      if (!input.items) {
        return compareManifests(baseline, candidate);
      }
      return analyzePairedRuns({ baseline, candidate, items: input.items });
    } catch (error) {
      throw new DomainError("EVALUATION_FAILED", error instanceof Error ? error.message : "Invalid evaluation contract", 422);
    }
  }

  async decide(ctx: RequestContext, runId: string) {
    this.authorizer.assert(ctx.actor, "evaluation:gate:decide");
    const run = await this.persistence.repos.evaluation.findRun(runId);
    const report = await this.persistence.repos.evaluation.findReportByRun(runId);
    if (!run || !report || !run.candidateId) {
      throw notFound("Evaluation report", runId);
    }
    const candidate = await this.persistence.repos.training.findCandidate(run.candidateId);
    if (!candidate) {
      throw notFound("Candidate", run.candidateId);
    }
    assertNotSelfDecision(ctx.actor, candidate.createdBy);
    const version = await this.requireVersion(run.benchmarkVersionId);
    const results = await this.persistence.repos.evaluation.listResults(runId);
    const baseline = results.filter((row) => row.role === "baseline");
    const candidateRows = results.filter((row) => row.role === "candidate");
    const paired = pairedCounts(
      baseline.map((row) => row.taskCorrect),
      candidateRows.map((row) => row.taskCorrect),
    );
    const loaded = await this.loadCandidate(candidate.id);
    const checksumsMatch =
      this.fileSha(loaded.trainable.artifactUri) === run.baseSha256 &&
      sha256File(this.roots.artifacts, join(this.roots.artifacts, loaded.artifact.relativePath)) === run.adapterSha256;
    const contaminated = await this.persistence.repos.evaluation.isArtifactContaminated(loaded.artifact.id);
    const stored = readStoredContract(run.decoding);
    const manifests = stored ?? {
      baseline: legacyManifest({
        decoding: run.decoding,
        benchmarkId: version.suiteId,
        benchmarkVersion: String(version.version),
        itemSetFingerprint: version.contentHash,
        promptTemplateDigest: version.promptTemplateHash,
        scorerId: version.scorerId,
        scorerVersion: version.scorerVersion,
        checkpointDigest: run.baseSha256,
        adapterDigest: null,
      }),
      candidate: legacyManifest({
        decoding: run.decoding,
        benchmarkId: version.suiteId,
        benchmarkVersion: String(version.version),
        itemSetFingerprint: version.contentHash,
        promptTemplateDigest: version.promptTemplateHash,
        scorerId: version.scorerId,
        scorerVersion: version.scorerVersion,
        checkpointDigest: run.baseSha256,
        adapterDigest: run.adapterSha256,
      }),
    };
    const comparison = compareManifests(manifests.baseline, manifests.candidate);
    const gateInput = {
      domain: version.domain,
      paired,
      baselineFormat: rate(baseline.map((row) => row.formatValid)),
      candidateFormat: rate(candidateRows.map((row) => row.formatValid)),
      checksumsMatch,
      contaminated,
    };
    const decision = !checksumsMatch || contaminated ? decideGate(gateInput) : applyGateIfComparable(comparison, gateInput);
    const row = {
      id: randomUUID(),
      candidateId: candidate.id,
      reportId: report.id,
      decision: decision.decision,
      rationale: decision.rationale,
      policyHash: gatePolicyHash(),
      decidedBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.evaluation.insertGate(row);
    await this.persistence.repos.audit.append({
      eventType: "evaluation.gate",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "model_candidate",
      targetId: candidate.id,
      action: "evaluation.gate",
      correlationId: ctx.correlationId,
      beforeState: { status: candidate.status },
      afterState: { decision: decision.decision, policyHash: row.policyHash },
      metadata: { critical: decision.critical, warnings: decision.warnings, sampleSize: paired.sampleSize },
    });
    const verdict = decision.decision === "PASS" ? "pass" : decision.decision === "INCONCLUSIVE" ? "inconclusive" : "fail";
    await this.notify(ctx, candidate.id, verdict, paired.difference);
    return { ...row, critical: decision.critical, warnings: decision.warnings, paired, comparison };
  }

  async quarantine(ctx: RequestContext, candidateId: string, reason: string) {
    this.authorizer.assert(ctx.actor, "evaluation:candidate:quarantine");
    const candidate = await this.persistence.repos.training.findCandidate(candidateId);
    if (!candidate) {
      throw notFound("Candidate", candidateId);
    }
    assertNotSelfDecision(ctx.actor, candidate.createdBy);
    await this.persistence.repos.training.updateCandidate(candidateId, "quarantined", this.now().toISOString());
    await this.audit(ctx, "candidate.quarantined", candidateId, { status: candidate.status }, { status: "quarantined", reason });
    return { id: candidateId, status: "quarantined" as const };
  }

  async revoke(ctx: RequestContext, candidateId: string, reason: string) {
    this.authorizer.assert(ctx.actor, "evaluation:gate:decide");
    const candidate = await this.persistence.repos.training.findCandidate(candidateId);
    if (!candidate) {
      throw notFound("Candidate", candidateId);
    }
    assertNotSelfDecision(ctx.actor, candidate.createdBy);
    await this.persistence.repos.training.updateCandidate(candidateId, "revoked", this.now().toISOString());
    const routes = await this.persistence.repos.evaluation.listRoutes();
    for (const route of routes) {
      if (route.currentVersion === null) {
        continue;
      }
      const current = await this.persistence.repos.evaluation.findRouteVersion(route.id, route.currentVersion);
      if (current?.candidateId !== candidateId) {
        continue;
      }
      const versions = await this.persistence.repos.evaluation.listRouteVersions(route.id);
      const fallback = [...versions].reverse().find((version) => version.version !== current.version && version.candidateId !== candidateId);
      await this.persistence.repos.evaluation.setRouteVersion(route.id, fallback?.version ?? null, this.now().toISOString());
    }
    await this.audit(ctx, "candidate.revoked", candidateId, { status: candidate.status }, { status: "revoked", reason });
    return { id: candidateId, status: "revoked" as const };
  }

  async changeRoute(ctx: RequestContext, input: { slug: string; kind: "baseline" | "candidate"; candidateId?: string; trainableModelId?: string }) {
    this.authorizer.assert(ctx.actor, "model:rollback:execute");
    const target = await this.routeTarget(input);
    const qwenBefore = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    let route = await this.persistence.repos.evaluation.findRouteBySlug(input.slug);
    if (!route) {
      route = { id: randomUUID(), slug: input.slug, currentVersion: null, updatedAt: this.now().toISOString() };
      await this.persistence.repos.evaluation.insertRoute(route);
    }
    const versions = await this.persistence.repos.evaluation.listRouteVersions(route.id);
    const version = {
      id: randomUUID(),
      routeId: route.id,
      version: versions.length + 1,
      kind: input.kind,
      candidateId: target.candidateId,
      trainableModelId: target.trainableModelId,
      adapterSha256: target.adapterSha256,
      baseSha256: target.baseSha256,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.transaction(async (repos) => {
      await repos.evaluation.insertRouteVersion(version);
      await repos.evaluation.setRouteVersion(route.id, version.version, this.now().toISOString());
    });
    const qwenAfter = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    if (qwenBefore?.status !== qwenAfter?.status || qwenBefore?.artifactUri !== qwenAfter?.artifactUri) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Experimental routing changed the production model row", 409);
    }
    return { routeId: route.id, version: version.version, kind: version.kind, adapterSha256: version.adapterSha256, baseSha256: version.baseSha256 };
  }

  async listRoutes(ctx: RequestContext) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    const routes = await this.persistence.repos.evaluation.listRoutes();
    const data = [];
    for (const route of routes) {
      data.push({ ...route, versions: await this.persistence.repos.evaluation.listRouteVersions(route.id) });
    }
    return { data };
  }

  async requestRollback(ctx: RequestContext, routeId: string, toVersion: number, reason: string) {
    this.authorizer.assert(ctx.actor, "model:rollback:request");
    const route = await this.requireRoute(routeId);
    if (route.currentVersion === null) {
      throw new DomainError("INVALID_STATE", "The experimental route has no active version", 409);
    }
    const target = await this.persistence.repos.evaluation.findRouteVersion(routeId, toVersion);
    if (!target) {
      throw notFound("Route version", String(toVersion));
    }
    const row = {
      id: randomUUID(),
      routeId,
      fromVersion: route.currentVersion,
      toVersion,
      status: "requested" as const,
      reason,
      requestedBy: ctx.actor.principalId,
      approvedBy: null,
      error: null,
      verification: null,
      createdAt: this.now().toISOString(),
      finishedAt: null,
    };
    await this.persistence.repos.evaluation.insertRollback(row);
    return row;
  }

  async approveRollback(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "model:rollback:approve");
    const row = await this.requireRollback(id);
    assertNotSelfDecision(ctx.actor, row.requestedBy);
    if (row.status !== "requested") {
      throw new DomainError("INVALID_STATE", "Only a requested rollback can be approved", 409);
    }
    await this.persistence.repos.evaluation.updateRollback(id, { status: "approved", approvedBy: ctx.actor.principalId });
    return { id, status: "approved" as const };
  }

  async executeRollback(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "model:rollback:execute");
    const row = await this.requireRollback(id);
    assertNotSelfDecision(ctx.actor, row.requestedBy);
    if (row.status !== "approved") {
      throw new DomainError("INVALID_STATE", "Rollback execution requires approval", 409);
    }
    const route = await this.requireRoute(row.routeId);
    const target = await this.persistence.repos.evaluation.findRouteVersion(row.routeId, row.toVersion);
    if (!target) {
      throw notFound("Route version", String(row.toVersion));
    }
    await this.persistence.repos.evaluation.setRouteVersion(route.id, target.version, this.now().toISOString());
    try {
      const verification = await this.verifyRoute(target);
      await this.persistence.repos.evaluation.updateRollback(id, { status: "completed", verification, finishedAt: this.now().toISOString() });
      await this.audit(ctx, "route.rolled_back", route.id, { version: row.fromVersion }, { version: row.toVersion, adapterSha256: target.adapterSha256 });
      return { id, status: "completed" as const, verification };
    } catch (error) {
      await this.persistence.repos.evaluation.setRouteVersion(route.id, row.fromVersion, this.now().toISOString());
      const message = error instanceof Error ? error.message : "rollback verification failed";
      await this.persistence.repos.evaluation.updateRollback(id, { status: "failed", error: message.slice(0, 500), finishedAt: this.now().toISOString() });
      throw error;
    }
  }

  async createRetention(ctx: RequestContext, input: { name: string; scope?: string; provenance?: string; maxAgeDays?: number }) {
    this.authorizer.assert(ctx.actor, "memory:retention:manage");
    const existing = await this.persistence.repos.evaluation.listRetention();
    const version = existing.filter((row) => row.name === input.name).length + 1;
    const row = {
      id: randomUUID(),
      name: input.name,
      version,
      scope: input.scope ?? null,
      provenance: input.provenance ?? null,
      maxAgeDays: input.maxAgeDays ?? null,
      createdBy: ctx.actor.principalId,
      createdAt: this.now().toISOString(),
    };
    await this.persistence.repos.evaluation.insertRetention(row);
    return { ...row, status: "published" as const };
  }

  async previewRetention(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "memory:retention:manage");
    const policy = (await this.persistence.repos.evaluation.listRetention()).find((row) => row.id === id);
    if (!policy) {
      throw notFound("Retention policy", id);
    }
    const olderThan = new Date(this.now().getTime() - (policy.maxAgeDays ?? 0) * 86_400_000);
    const ids = await this.persistence.repos.memories.retentionIds({
      scope: policy.scope,
      provenance: policy.provenance,
      olderThan: policy.maxAgeDays === null ? new Date(0) : olderThan,
    });
    return { policyId: id, matchCount: ids.length, memoryIds: ids, deletes: false };
  }

  async getForgetting(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "evaluation:read");
    return this.requireForgetting(id);
  }

  async requestForgetting(ctx: RequestContext, memoryId: string, idempotencyKey: string) {
    this.authorizer.assert(ctx.actor, "memory:forget:request");
    const existing = await this.persistence.repos.evaluation.findForgettingByKey(idempotencyKey);
    if (existing) {
      return existing;
    }
    const memory = await this.persistence.repos.memories.findById(memoryId);
    if (!memory || memory.status === "forgotten") {
      throw notFound("Memory", memoryId);
    }
    const impact = await this.impactOf(memoryId);
    const row = {
      id: randomUUID(),
      memoryId,
      status: "requested" as const,
      idempotencyKey,
      impact,
      requestedBy: ctx.actor.principalId,
      approvedBy: null,
      error: null,
      createdAt: this.now().toISOString(),
      finishedAt: null,
    };
    await this.persistence.repos.evaluation.insertForgetting(row);
    await this.audit(ctx, "memory.forget.requested", memoryId, { status: memory.status }, { requestId: row.id, relation: impact.relation });
    return row;
  }

  async approveForgetting(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "memory:forget:approve");
    const row = await this.requireForgetting(id);
    assertNotSelfDecision(ctx.actor, row.requestedBy);
    if (row.status !== "requested") {
      throw new DomainError("INVALID_STATE", "Only a requested forgetting job can be approved", 409);
    }
    await this.persistence.repos.evaluation.updateForgetting(id, { status: "approved", approvedBy: ctx.actor.principalId });
    return { id, status: "approved" as const };
  }

  async executeForgetting(ctx: RequestContext, id: string) {
    this.authorizer.assert(ctx.actor, "memory:forget:execute");
    const row = await this.requireForgetting(id);
    assertNotSelfDecision(ctx.actor, row.requestedBy);
    if (row.status === "completed") {
      return row;
    }
    if (row.status !== "approved") {
      throw new DomainError("INVALID_STATE", "Forgetting execution requires approval", 409);
    }
    const impact = row.impact as { derivedMemoryIds?: string[]; promotionCopyIds?: string[]; artifactIds?: string[]; relation?: string };
    const ids = [row.memoryId, ...(impact.derivedMemoryIds ?? []), ...(impact.promotionCopyIds ?? [])];
    await this.persistence.transaction(async (repos) => {
      for (const memoryId of [...new Set(ids)]) {
        await repos.memories.tombstone(memoryId, this.now());
        await repos.evaluation.insertLineage({
          id: randomUUID(),
          fromType: "memory",
          fromId: memoryId,
          toType: "forgetting_request",
          toId: row.id,
          relation: impact.relation === "definitely_used" ? "definitely_used" : "not_used",
          createdAt: this.now().toISOString(),
        });
      }
      for (const artifactId of impact.artifactIds ?? []) {
        await repos.evaluation.contaminate({
          id: randomUUID(),
          artifactId,
          forgettingRequestId: row.id,
          relation: "definitely_used",
          createdAt: this.now().toISOString(),
        });
      }
      await repos.evaluation.updateForgetting(id, { status: "completed", finishedAt: this.now().toISOString() });
    });
    await this.audit(ctx, "memory.forgotten", row.memoryId, null, { requestId: id, tombstone: true, backupsRemain: true, weightsUnchanged: true });
    return this.requireForgetting(id);
  }

  private async impactOf(memoryId: string): Promise<Record<string, unknown>> {
    const impact = await this.persistence.repos.evaluation.memoryImpact(memoryId);
    return {
      ...impact,
      backupLimitation: "Deleting the live row does not erase database backups or knowledge stored in model weights.",
      weightUnlearning: false,
    };
  }

  private async verifyRoute(version: { kind: "baseline" | "candidate"; candidateId: string | null; trainableModelId: string; adapterSha256: string | null; baseSha256: string }) {
    const qwenBefore = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    const trainable = await this.persistence.repos.training.findTrainable(version.trainableModelId);
    if (!trainable || this.fileSha(trainable.artifactUri) !== version.baseSha256) {
      throw new DomainError("ARTIFACT_MISMATCH", "Rollback target base checksum does not match", 409);
    }
    let adapterPath: string | null = null;
    if (version.kind === "candidate") {
      if (!version.candidateId || !version.adapterSha256) {
        throw new DomainError("ADAPTER_NOT_LOADED", "Candidate route is missing an adapter", 409);
      }
      const loaded = await this.loadCandidate(version.candidateId);
      adapterPath = join(this.roots.artifacts, loaded.artifact.relativePath);
      if (sha256File(this.roots.artifacts, adapterPath) !== version.adapterSha256) {
        throw new DomainError("ARTIFACT_MISMATCH", "Rollback target adapter checksum does not match", 409);
      }
      if (await this.persistence.repos.evaluation.isArtifactContaminated(loaded.artifact.id)) {
        throw new DomainError("CONTAMINATED", "Rollback refused a contaminated adapter", 409);
      }
    }
    const [output] = await this.provider.predict({
      mode: version.kind === "candidate" ? "candidate" : "baseline",
      prompts: ["0 + 10"],
      modelPath: this.modelDirectory(trainable.artifactUri),
      adapterPath,
      expectedAdapterSha256: version.adapterSha256,
      artifactRoot: this.roots.artifacts,
      outputDir: join(this.roots.artifacts, "routes", randomUUID()),
    });
    const qwenAfter = await this.persistence.repos.models.findById(QWEN3_8B_MODEL_ID);
    if (qwenBefore?.status !== qwenAfter?.status || qwenBefore?.artifactUri !== qwenAfter?.artifactUri) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Rollback changed the production model row", 409);
    }
    return {
      output: output ?? "",
      kind: version.kind,
      adapterSha256: version.adapterSha256,
      baseSha256: version.baseSha256,
      loadedAdapter: version.kind === "candidate",
      productionUnchanged: true,
    };
  }

  private async routeTarget(input: { kind: "baseline" | "candidate"; candidateId?: string; trainableModelId?: string }) {
    if (input.kind === "candidate") {
      if (!input.candidateId) {
        throw new DomainError("INVALID_STATE", "A candidate route needs a candidate id", 422);
      }
      const loaded = await this.loadCandidate(input.candidateId);
      if (loaded.candidate.status === "revoked" || loaded.candidate.status === "quarantined") {
        throw new DomainError("NOT_APPROVED", "A revoked or quarantined candidate cannot become the active route", 409);
      }
      if (await this.persistence.repos.evaluation.isArtifactContaminated(loaded.artifact.id)) {
        throw new DomainError("CONTAMINATED", "A contaminated adapter cannot become the active route", 409);
      }
      return {
        candidateId: loaded.candidate.id,
        trainableModelId: loaded.trainable.id,
        adapterSha256: loaded.artifact.sha256,
        baseSha256: loaded.trainable.sha256,
      };
    }
    const trainableId = input.trainableModelId;
    if (!trainableId) {
      throw new DomainError("INVALID_STATE", "A baseline route needs a trainable checkpoint", 422);
    }
    const trainable = await this.persistence.repos.training.findTrainable(trainableId);
    if (!trainable || trainable.registryModelId === QWEN3_8B_MODEL_ID) {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "The experimental route cannot target production Qwen", 409);
    }
    return { candidateId: null, trainableModelId: trainable.id, adapterSha256: null, baseSha256: trainable.sha256 };
  }

  private async loadCandidate(id: string) {
    const candidate = await this.persistence.repos.training.findCandidate(id);
    if (!candidate) {
      throw notFound("Candidate", id);
    }
    const adapter = await this.persistence.repos.training.findAdapter(candidate.adapterId);
    if (!adapter) {
      throw notFound("Adapter", candidate.adapterId);
    }
    const artifact = (await this.persistence.repos.training.listArtifacts(candidate.runId)).find((row) => row.id === adapter.artifactId);
    const trainable = await this.persistence.repos.training.findTrainable(adapter.baseTrainableModelId);
    if (!artifact || !trainable) {
      throw new DomainError("ARTIFACT_MISMATCH", "The candidate is missing its adapter or base checkpoint", 409);
    }
    if (trainable.registryModelId === QWEN3_8B_MODEL_ID || trainable.modelFamily !== "gemma-3") {
      throw new DomainError("PRODUCTION_MODEL_ISOLATED", "Evaluation cannot treat Qwen as the Gemma candidate", 409);
    }
    return { candidate, adapter, artifact, trainable };
  }

  private async predict(loaded: Awaited<ReturnType<EvaluationService["loadCandidate"]>>, prompts: string[], mode: "baseline" | "candidate") {
    return this.provider.predict({
      mode,
      prompts,
      modelPath: this.modelDirectory(loaded.trainable.artifactUri),
      adapterPath: mode === "candidate" ? join(this.roots.artifacts, loaded.artifact.relativePath) : null,
      expectedAdapterSha256: mode === "candidate" ? loaded.artifact.sha256 : null,
      artifactRoot: this.roots.artifacts,
      outputDir: join(this.roots.artifacts, "evaluations", randomUUID()),
    });
  }

  private async canReadSealed(ctx: RequestContext): Promise<boolean> {
    if (ctx.actor.role === "system_administrator") {
      return true;
    }
    if (!ctx.actor.permissions.includes("evaluation:run") || !ctx.actor.departmentId) {
      return false;
    }
    const department = await this.persistence.repos.departments.findById(ctx.actor.departmentId);
    return department?.slug === "evaluation";
  }

  private async requireVersion(id: string) {
    const version = await this.persistence.repos.evaluation.findVersion(id);
    if (!version) {
      throw notFound("Benchmark version", id);
    }
    return version;
  }

  private async requireRoute(id: string) {
    const route = await this.persistence.repos.evaluation.findRoute(id);
    if (!route) {
      throw notFound("Experimental route", id);
    }
    return route;
  }

  private async requireRollback(id: string) {
    const row = await this.persistence.repos.evaluation.findRollback(id);
    if (!row) {
      throw notFound("Rollback request", id);
    }
    return row;
  }

  private async requireForgetting(id: string) {
    const row = await this.persistence.repos.evaluation.findForgetting(id);
    if (!row) {
      throw notFound("Forgetting request", id);
    }
    return row;
  }

  private publicVersion(
    version: { id: string; suiteId: string; version: number; status: string; sealed: boolean; contentHash: string; scorerId: string; scorerVersion: string; domain: string; description: string },
    reveal: boolean,
    items: Array<{ ordinal: number; prompt: string; expected: string }> = [],
  ) {
    return {
      id: version.id,
      suiteId: version.suiteId,
      version: version.version,
      status: version.status,
      sealed: version.sealed,
      domain: version.domain,
      description: version.description,
      contentHash: version.contentHash,
      scorerId: version.scorerId,
      scorerVersion: version.scorerVersion,
      items: reveal ? items.map((item) => ({ ordinal: item.ordinal, prompt: item.prompt, expected: item.expected })) : [],
    };
  }

  private fileSha(path: string): string {
    return createHash("sha256").update(readFileSync(realpathSync(path))).digest("hex");
  }

  private modelDirectory(artifactUri: string): string {
    return statSync(artifactUri).isDirectory() ? artifactUri : dirname(artifactUri);
  }

  private async notify(ctx: RequestContext, subjectId: string, verdict: "pass" | "fail" | "inconclusive", difference: number) {
    if (!ctx.actor.agentId || !ctx.actor.departmentId) {
      return;
    }
    try {
      await this.messages.send(ctx, {
        messageType: "EVALUATION_RESULT",
        recipientDepartmentId: ctx.actor.departmentId,
        priority: 5,
        idempotencyKey: `eval.${subjectId}.${verdict}.${randomUUID().slice(0, 8)}`,
        payload: {
          subjectType: "model",
          subjectId,
          verdict,
          metrics: { difference },
          notes: "Evaluation result. This message does not approve a candidate or change production routing.",
        },
      });
    } catch {
      // A notification failure does not change the stored evaluation.
    }
  }

  private async audit(ctx: RequestContext, action: string, targetId: string, beforeState: Record<string, unknown> | null, afterState: Record<string, unknown>) {
    await this.persistence.repos.audit.append({
      eventType: action,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: action.startsWith("memory") ? "memory" : "model_candidate",
      targetId,
      action,
      correlationId: ctx.correlationId,
      beforeState,
      afterState,
      metadata: {},
    });
  }
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rate(flags: boolean[]): number {
  if (flags.length === 0) {
    return 0;
  }
  return flags.filter(Boolean).length / flags.length;
}

function resultRow(
  runId: string,
  ordinal: number,
  role: "baseline" | "candidate",
  rawOutput: string,
  grade: { taskCorrect: boolean; formatValid: boolean; strictIntegerMatch: boolean; ambiguous: boolean; equationValue: string | null },
) {
  return {
    id: randomUUID(),
    runId,
    ordinal,
    role,
    rawOutput,
    taskCorrect: grade.taskCorrect,
    formatValid: grade.formatValid,
    strictIntegerMatch: grade.strictIntegerMatch,
    ambiguous: grade.ambiguous,
    equationValue: grade.equationValue,
  };
}
