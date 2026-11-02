import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RequestContext } from "../context.js";
import { configurationFingerprint, parseEvaluationManifest } from "../evaluation/manifest.js";
import { wilsonInterval } from "../evaluation/stats.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import type { Persistence } from "../ports/repositories.js";
import { applyHolm } from "./holm.js";
import { compareCertifiedSnapshots, type LedgerComparison } from "./compare.js";
import type { CapabilityRepository } from "./repository.js";
import { reconstructTaxonomy, validateTaxonomyGraph } from "./taxonomy.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type CapabilityKind,
  type LedgerSnapshot,
  type MappingItemInput,
  type MeasurementMode,
  type ModelIdentitySeparation,
  type ProposalDecision,
  type SnapshotItem,
  type TaxonomyNodeInput,
} from "./types.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nodeSchema = z
  .object({
    topicId: z.string().uuid(),
    parentTopicId: z.string().uuid().nullable(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable(),
    status: z.enum(["active", "deprecated"]),
    crossLinks: z.array(z.string().uuid()).max(32),
  })
  .strict();
const taxonomyPayload = z.object({ nodes: z.array(nodeSchema).min(1).max(500) }).strict();
const mappingItemSchema = z
  .object({
    itemId: z.string().min(1).max(80),
    contentDigest: digest,
    topicId: z.string().uuid(),
    weight: z.number().gt(0).lte(1).nullable(),
    provenance: z.string().min(1).max(500),
  })
  .strict();
const mappingPayload = z
  .object({
    taxonomyVersionId: z.string().uuid(),
    items: z.array(mappingItemSchema).min(1).max(2000),
  })
  .strict();

const READ_SLUGS = new Set(["weight-optimization", "evaluation", "monitoring", "memory-and-forgetting"]);
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export class CapabilityLedgerService {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly ids: () => string = randomUUID,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private get store(): CapabilityRepository {
    return this.persistence.repos.capability;
  }

  async registerTopic(ctx: RequestContext, input: { departmentId: string; provenance: string }) {
    await this.assertOwnProposal(ctx, input.departmentId);
    const topic = {
      id: this.ids(),
      departmentId: input.departmentId,
      createdBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
      provenance: input.provenance,
    };
    await this.store.insertTopic(topic);
    return topic;
  }

  async recordTopicEvent(
    ctx: RequestContext,
    topicId: string,
    input: { eventType: "rename" | "describe" | "deprecate"; name?: string; description?: string },
  ) {
    const topic = await this.requireTopic(topicId);
    await this.assertOwnProposal(ctx, topic.departmentId);
    if (input.eventType === "rename" && !input.name?.trim()) {
      throw new DomainError("VALIDATION_ERROR", "A rename needs a name", 422);
    }
    const event = {
      id: this.ids(),
      topicId,
      eventType: input.eventType,
      name: input.name ?? null,
      description: input.description ?? null,
      createdBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertTopicEvent(event);
    return { topicId, event };
  }

  async proposeTaxonomy(ctx: RequestContext, input: { departmentId: string; nodes: TaxonomyNodeInput[] }) {
    await this.assertOwnProposal(ctx, input.departmentId);
    const payload = taxonomyPayload.parse({ nodes: input.nodes });
    await this.assertTopicsOwned(input.departmentId, payload.nodes);
    const known = await this.knownTopics(payload.nodes);
    validateTaxonomyGraph(payload.nodes, known);
    const proposal = {
      id: this.ids(),
      departmentId: input.departmentId,
      kind: "taxonomy" as const,
      payload,
      proposedBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertProposal(proposal);
    return proposal;
  }

  async decideTaxonomy(ctx: RequestContext, proposalId: string, decision: ProposalDecision) {
    this.authorizer.assert(ctx.actor, "capability:approve");
    const proposal = await this.requireProposal(proposalId, "taxonomy");
    this.assertDifferentPrincipal(ctx, proposal.proposedBy);
    if (await this.store.findDecision(proposalId)) {
      throw new DomainError("CONFLICT", "That proposal already has a decision", 409);
    }
    const payload = taxonomyPayload.parse(proposal.payload);
    await this.store.insertDecision({
      id: this.ids(),
      proposalId,
      decision,
      decidedBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    });
    if (decision === "rejected") {
      return { proposalId, decision, version: null };
    }
    const known = await this.knownTopics(payload.nodes);
    validateTaxonomyGraph(payload.nodes, known);
    const existing = await this.store.listTaxonomyVersions(proposal.departmentId);
    const version = {
      id: this.ids(),
      departmentId: proposal.departmentId,
      version: existing.length + 1,
      proposalId,
      createdBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertTaxonomyVersion(version);
    const edges = [];
    for (const node of payload.nodes) {
      edges.push({
        id: this.ids(),
        versionId: version.id,
        topicId: node.topicId,
        parentTopicId: node.parentTopicId,
        kind: "parent" as const,
        name: node.name,
        description: node.description,
        status: node.status,
        targetDepartmentId: null,
      });
      for (const link of node.crossLinks) {
        const target = await this.store.findTopic(link);
        edges.push({
          id: this.ids(),
          versionId: version.id,
          topicId: node.topicId,
          parentTopicId: link,
          kind: "cross_link" as const,
          name: node.name,
          description: node.description,
          status: node.status,
          targetDepartmentId: target?.departmentId ?? null,
        });
      }
    }
    await this.store.insertEdges(edges);
    return { proposalId, decision, version };
  }

  async proposeMapping(ctx: RequestContext, input: { departmentId: string; taxonomyVersionId: string; items: MappingItemInput[] }) {
    await this.assertOwnProposal(ctx, input.departmentId);
    const payload = mappingPayload.parse({ taxonomyVersionId: input.taxonomyVersionId, items: input.items });
    await this.assertMappingTargets(input.departmentId, payload.taxonomyVersionId, payload.items);
    const proposal = {
      id: this.ids(),
      departmentId: input.departmentId,
      kind: "mapping" as const,
      payload,
      proposedBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertProposal(proposal);
    return proposal;
  }

  async decideMapping(ctx: RequestContext, proposalId: string, decision: ProposalDecision) {
    this.authorizer.assert(ctx.actor, "evaluation:suite:approve");
    const proposal = await this.requireProposal(proposalId, "mapping");
    this.assertDifferentPrincipal(ctx, proposal.proposedBy);
    if (ctx.actor.departmentId === proposal.departmentId) {
      throw new DomainError("SELF_APPROVAL", "A department cannot approve mappings that score its own capability", 403);
    }
    if (await this.store.findDecision(proposalId)) {
      throw new DomainError("CONFLICT", "That proposal already has a decision", 409);
    }
    const payload = mappingPayload.parse(proposal.payload);
    await this.assertMappingTargets(proposal.departmentId, payload.taxonomyVersionId, payload.items);
    await this.store.insertDecision({
      id: this.ids(),
      proposalId,
      decision,
      decidedBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    });
    if (decision === "rejected") {
      return { proposalId, decision, version: null };
    }
    const existing = await this.store.listMappingVersions(proposal.departmentId);
    const version = {
      id: this.ids(),
      departmentId: proposal.departmentId,
      version: existing.length + 1,
      taxonomyVersionId: payload.taxonomyVersionId,
      proposalId,
      createdBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertMappingVersion(version);
    await this.store.insertMappings(
      payload.items.map((item) => ({
        id: this.ids(),
        mappingVersionId: version.id,
        itemId: item.itemId,
        contentDigest: item.contentDigest,
        topicId: item.topicId,
        weight: item.weight,
        provenance: item.provenance,
      })),
    );
    return { proposalId, decision, version };
  }

  async certifySnapshot(
    ctx: RequestContext,
    input: {
      departmentId: string;
      topicId: string;
      taxonomyVersionId: string;
      mappingVersionId: string;
      evaluationRunId?: string | null;
      evidenceRef: string;
      manifest: unknown;
      measuredAt: string;
      correctCount: number;
      incorrectCount: number;
      failureClasses: Record<string, number>;
      measurementMode: MeasurementMode;
      capabilityKind: CapabilityKind;
      items: SnapshotItem[];
      provenance: string;
    },
  ): Promise<LedgerSnapshot> {
    this.authorizer.assert(ctx.actor, "evaluation:suite:approve");
    if (ctx.actor.departmentId !== null && ctx.actor.departmentId === input.departmentId) {
      throw new DomainError("SELF_APPROVAL", "A department cannot certify its own capability score", 403);
    }
    let manifest;
    try {
      manifest = parseEvaluationManifest(input.manifest);
    } catch {
      throw new DomainError("EVALUATION_FAILED", "The evaluation manifest is not valid", 422);
    }
    if (manifest.execution.status.state !== "set" || manifest.execution.status.value !== "completed") {
      throw new DomainError("EVALUATION_FAILED", "Only a completed evaluation can certify a capability", 422);
    }
    if (manifest.generation.retrieval.state !== "set" || manifest.generation.retrieval.value !== input.measurementMode) {
      throw new DomainError("EVALUATION_FAILED", "Measurement mode does not match the evaluation manifest", 422);
    }
    if (manifest.evaluation.itemCount.state !== "set") {
      throw new DomainError("EVALUATION_FAILED", "The evaluation item count is unknown", 422);
    }
    const sampleSize = input.correctCount + input.incorrectCount;
    if (sampleSize < 1 || manifest.evaluation.itemCount.value !== sampleSize || input.items.length !== sampleSize) {
      throw new DomainError("VALIDATION_ERROR", "An empty or mismatched measurement is not a capability score", 422);
    }
    if (input.items.some((item) => item.correct === null || !item.valid)) {
      throw new DomainError("EVALUATION_FAILED", "Official certification requires a valid outcome for every included item", 422);
    }
    const correct = input.items.filter((item) => item.correct === true).length;
    if (correct !== input.correctCount) {
      throw new DomainError("VALIDATION_ERROR", "Correct count does not match the item outcomes", 422);
    }
    for (const [name, count] of Object.entries(input.failureClasses)) {
      if (!name || !Number.isInteger(count) || count < 0) {
        throw new DomainError("VALIDATION_ERROR", "Failure classifications must be non-negative counts", 422);
      }
    }
    const mapping = await this.store.findMappingVersion(input.mappingVersionId);
    if (!mapping || mapping.departmentId !== input.departmentId || mapping.taxonomyVersionId !== input.taxonomyVersionId) {
      throw new DomainError("NOT_APPROVED", "Official scores require an approved mapping for this taxonomy version", 422);
    }
    const edges = await this.store.listEdges(input.taxonomyVersionId);
    if (!edges.some((edge) => edge.kind === "parent" && edge.topicId === input.topicId)) {
      throw new DomainError("VALIDATION_ERROR", "The topic is not in the taxonomy version", 422);
    }
    const topic = await this.requireTopic(input.topicId);
    if (topic.departmentId !== input.departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "A mapping cannot score another department's topic", 403);
    }
    const rows = await this.store.listMappings(mapping.id);
    const covered = new Map(rows.filter((row) => row.topicId === input.topicId).map((row) => [row.itemId, row]));
    for (const item of input.items) {
      const row = covered.get(item.itemId);
      if (!row || row.contentDigest !== item.contentDigest) {
        throw new DomainError("NOT_APPROVED", "An item is not on the approved mapping for this topic", 422);
      }
    }
    const interval = wilsonInterval(input.correctCount, sampleSize);
    const snapshot: LedgerSnapshot = {
      id: this.ids(),
      departmentId: input.departmentId,
      topicId: input.topicId,
      taxonomyVersionId: input.taxonomyVersionId,
      mappingVersionId: input.mappingVersionId,
      evaluationRunId: input.evaluationRunId ?? null,
      evidenceRef: input.evidenceRef,
      manifestFingerprint: configurationFingerprint(manifest),
      manifest,
      modelFamily: valueOrNull(manifest.model.family),
      modelIdentifier: valueOrNull(manifest.model.identifier),
      checkpointDigest: valueOrNull(manifest.model.checkpointDigest),
      adapterId: valueOrNull(manifest.model.adapterId),
      adapterDigest: valueOrNull(manifest.model.adapterDigest),
      measuredAt: input.measuredAt,
      validity: "valid",
      sampleSize,
      correctCount: input.correctCount,
      incorrectCount: input.incorrectCount,
      failureClasses: input.failureClasses,
      accuracy: input.correctCount / sampleSize,
      uncertaintyLow: interval.low,
      uncertaintyHigh: interval.high,
      measurementMode: input.measurementMode,
      capabilityKind: input.capabilityKind,
      items: input.items,
      provenance: input.provenance,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      certifiedBy: ctx.actor.principalId,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertSnapshot(snapshot);
    return snapshot;
  }

  async recordRetention(ctx: RequestContext, snapshotId: string, input: { action: "retain" | "revoke" | "archive"; reason: string }) {
    const snapshot = await this.requireSnapshot(snapshotId);
    await this.assertRetentionAuthority(ctx);
    if (input.reason.trim().length === 0) {
      throw new DomainError("VALIDATION_ERROR", "A retention decision needs a reason", 422);
    }
    const event = {
      id: this.ids(),
      snapshotId,
      action: input.action,
      decidedBy: ctx.actor.principalId,
      reason: input.reason,
      createdAt: this.clock().toISOString(),
    };
    await this.store.insertRetention(event);
    return { snapshotId, departmentId: snapshot.departmentId, event };
  }

  async listTaxonomyVersions(ctx: RequestContext, departmentId: string) {
    await this.assertRead(ctx, departmentId, "approved");
    return this.store.listTaxonomyVersions(departmentId);
  }

  async getTaxonomy(ctx: RequestContext, versionId: string) {
    const version = await this.store.findTaxonomyVersion(versionId);
    if (!version) {
      throw notFound("Taxonomy version", versionId);
    }
    await this.assertRead(ctx, version.departmentId, "approved");
    const tree = reconstructTaxonomy(await this.store.listEdges(versionId));
    return { version, tree };
  }

  async getSnapshot(ctx: RequestContext, snapshotId: string) {
    const snapshot = await this.requireSnapshot(snapshotId);
    await this.assertRead(ctx, snapshot.departmentId, "approved");
    if (await this.revoked(snapshot.id) && !(await this.canSeeRevoked(ctx))) {
      throw notFound("Capability snapshot", snapshotId);
    }
    return { snapshot, modelIdentity: separateModelIdentity(snapshot), evidence: snapshot.manifest };
  }

  async history(ctx: RequestContext, filter: { departmentId: string; topicId?: string }) {
    await this.assertRead(ctx, filter.departmentId, "approved");
    const rows = await this.visibleSnapshots(ctx, filter);
    return rows.sort(byMeasurement);
  }

  async compare(ctx: RequestContext, input: { baselineId: string; candidateId: string; commonItemDesign?: boolean; attributeAdapterContrast?: boolean }) {
    const baseline = await this.requireSnapshot(input.baselineId);
    const candidate = await this.requireSnapshot(input.candidateId);
    await this.assertRead(ctx, baseline.departmentId, "approved");
    await this.assertRead(ctx, candidate.departmentId, "approved");
    if ((await this.revoked(baseline.id) || await this.revoked(candidate.id)) && !(await this.canSeeRevoked(ctx))) {
      throw new DomainError("AUTHORIZATION_DENIED", "Revoked evidence is not available for this comparison", 403);
    }
    const comparison = compareCertifiedSnapshots({
      baseline,
      candidate,
      baselineMappings: await this.store.listMappings(baseline.mappingVersionId),
      candidateMappings: await this.store.listMappings(candidate.mappingVersionId),
      commonItemDesign: input.commonItemDesign,
      attributeAdapterContrast: input.attributeAdapterContrast,
    });
    return comparison;
  }

  async overview(ctx: RequestContext, departmentId: string, taxonomyVersionId: string, asOf = this.clock()) {
    await this.assertRead(ctx, departmentId, "approved");
    const version = await this.store.findTaxonomyVersion(taxonomyVersionId);
    if (!version || version.departmentId !== departmentId) {
      throw notFound("Taxonomy version", taxonomyVersionId);
    }
    const tree = reconstructTaxonomy(await this.store.listEdges(taxonomyVersionId));
    const snapshots = (await this.visibleSnapshots(ctx, { departmentId })).filter((row) => row.taxonomyVersionId === taxonomyVersionId);
    const topics = tree.map((node) => {
      const measurements = snapshots.filter((row) => row.topicId === node.topicId).sort(byMeasurement);
      const latest = measurements.at(-1) ?? null;
      return {
        topicId: node.topicId,
        name: node.name,
        status: node.status,
        coverage: latest ? ("measured" as const) : ("untested" as const),
        latest,
        historyCount: measurements.length,
        freshness: latest ? freshness(latest.measuredAt, asOf.toISOString()) : null,
        modelIdentity: latest ? separateModelIdentity(latest) : null,
      };
    });
    const pairs = topics
      .map((topic) => {
        const measurements = snapshots.filter((row) => row.topicId === topic.topicId && row.validity === "valid").sort(byMeasurement);
        if (measurements.length < 2) {
          return null;
        }
        return { topicId: topic.topicId, baseline: measurements[measurements.length - 2] as LedgerSnapshot, candidate: measurements[measurements.length - 1] as LedgerSnapshot };
      })
      .filter((row): row is { topicId: string; baseline: LedgerSnapshot; candidate: LedgerSnapshot } => row !== null);
    const compared = [];
    for (const pair of pairs) {
      const result = compareCertifiedSnapshots({
        baseline: pair.baseline,
        candidate: pair.candidate,
        baselineMappings: await this.store.listMappings(pair.baseline.mappingVersionId),
        candidateMappings: await this.store.listMappings(pair.candidate.mappingVersionId),
      });
      compared.push({ topicId: pair.topicId, baselineId: pair.baseline.id, candidateId: pair.candidate.id, ...result });
    }
    const adjusted = applyHolm(compared);
    return {
      taxonomyVersionId,
      topics,
      comparisons: adjusted,
      possibleRegressions: adjusted.filter((row) => row.verdict === "regression").map((row) => row.topicId),
      untestedTopics: topics.filter((topic) => topic.coverage === "untested" && topic.status === "active").map((topic) => topic.topicId),
      assignedModel: null,
      servingModel: null,
      note: "The latest snapshot is the newest valid measurement. It is not a best score, a model assignment, or proof that the historical model is loaded.",
    };
  }

  private async visibleSnapshots(ctx: RequestContext, filter: { departmentId: string; topicId?: string }) {
    const rows = await this.store.listSnapshots(filter);
    if (await this.canSeeRevoked(ctx)) {
      return rows;
    }
    const visible: LedgerSnapshot[] = [];
    for (const row of rows) {
      if (!(await this.revoked(row.id))) {
        visible.push(row);
      }
    }
    return visible;
  }

  private async revoked(snapshotId: string): Promise<boolean> {
    const events = await this.store.listRetention(snapshotId);
    return events.at(-1)?.action === "revoke";
  }

  private async canSeeRevoked(ctx: RequestContext): Promise<boolean> {
    if (ctx.actor.role === "system_administrator") {
      return true;
    }
    const slug = await this.actorSlug(ctx);
    return slug === "memory-and-forgetting" || slug === "evaluation";
  }

  private async assertOwnProposal(ctx: RequestContext, departmentId: string) {
    this.authorizer.assert(ctx.actor, "learning:propose");
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    if (ctx.actor.departmentId !== departmentId) {
      throw new DomainError("AUTHORIZATION_DENIED", "A department can propose capability structure only for itself", 403);
    }
  }

  private async assertRead(ctx: RequestContext, departmentId: string, scope: "approved" | "proposal") {
    if (ctx.actor.role === "system_administrator") {
      return;
    }
    if (ctx.actor.departmentId === departmentId) {
      this.authorizer.assert(ctx.actor, "learning:read");
      return;
    }
    if (scope === "proposal") {
      throw new DomainError("AUTHORIZATION_DENIED", "Another department's proposals are not visible", 403);
    }
    this.authorizer.assert(ctx.actor, "evaluation:read");
    const slug = await this.actorSlug(ctx);
    if (ctx.actor.role === "monitoring_agent" || ctx.actor.role === "read_only_observer" || (slug !== null && READ_SLUGS.has(slug))) {
      return;
    }
    throw new DomainError("AUTHORIZATION_DENIED", "Cross-department capability evidence is restricted", 403);
  }

  private async assertRetentionAuthority(ctx: RequestContext) {
    if (ctx.actor.role === "system_administrator") {
      this.authorizer.assert(ctx.actor, "memory:forget:approve");
      return;
    }
    this.authorizer.assert(ctx.actor, "memory:forget:request");
    const slug = await this.actorSlug(ctx);
    if (slug !== "memory-and-forgetting") {
      throw new DomainError("AUTHORIZATION_DENIED", "Retention decisions belong to Memory & Forgetting", 403);
    }
  }

  private assertDifferentPrincipal(ctx: RequestContext, proposedBy: string) {
    if (ctx.actor.principalId === proposedBy) {
      throw new DomainError("SELF_APPROVAL", "The proposer cannot activate this change", 403);
    }
  }

  private async assertTopicsOwned(departmentId: string, nodes: TaxonomyNodeInput[]) {
    for (const node of nodes) {
      const topic = await this.requireTopic(node.topicId);
      if (topic.departmentId !== departmentId) {
        throw new DomainError("AUTHORIZATION_DENIED", "A taxonomy cannot adopt another department's topic", 403, { topicId: node.topicId });
      }
    }
  }

  private async knownTopics(nodes: TaxonomyNodeInput[]): Promise<Set<string>> {
    const known = new Set<string>();
    for (const node of nodes) {
      for (const link of node.crossLinks) {
        if (await this.store.findTopic(link)) {
          known.add(link);
        }
      }
    }
    return known;
  }

  private async assertMappingTargets(departmentId: string, taxonomyVersionId: string, items: MappingItemInput[]) {
    const version = await this.store.findTaxonomyVersion(taxonomyVersionId);
    if (!version || version.departmentId !== departmentId) {
      throw new DomainError("VALIDATION_ERROR", "The taxonomy version does not belong to this department", 422);
    }
    const edges = await this.store.listEdges(taxonomyVersionId);
    const topics = new Set(edges.filter((edge) => edge.kind === "parent").map((edge) => edge.topicId));
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.itemId}\n${item.topicId}`;
      if (seen.has(key)) {
        throw new DomainError("VALIDATION_ERROR", "A mapping version can attach an item to a topic only once", 422);
      }
      seen.add(key);
      if (!topics.has(item.topicId)) {
        throw new DomainError("VALIDATION_ERROR", "A mapping cannot target a topic outside the taxonomy version", 422, { topicId: item.topicId });
      }
      const topic = await this.requireTopic(item.topicId);
      if (topic.departmentId !== departmentId) {
        throw new DomainError("AUTHORIZATION_DENIED", "A mapping cannot score another department's topic", 403);
      }
    }
  }

  private async actorSlug(ctx: RequestContext): Promise<string | null> {
    if (!ctx.actor.departmentId) {
      return null;
    }
    const department = await this.persistence.repos.departments.findById(ctx.actor.departmentId);
    return department?.slug ?? null;
  }

  private async requireTopic(id: string) {
    const topic = await this.store.findTopic(id);
    if (!topic) {
      throw notFound("Topic", id);
    }
    return topic;
  }

  private async requireProposal(id: string, kind: "taxonomy" | "mapping") {
    const proposal = await this.store.findProposal(id);
    if (!proposal || proposal.kind !== kind) {
      throw notFound("Proposal", id);
    }
    return proposal;
  }

  private async requireSnapshot(id: string) {
    const snapshot = await this.store.findSnapshot(id);
    if (!snapshot) {
      throw notFound("Capability snapshot", id);
    }
    return snapshot;
  }
}

function valueOrNull<T>(presence: { state: string; value?: T }): T | null {
  return presence.state === "set" ? (presence.value as T) : null;
}

function byMeasurement(left: LedgerSnapshot, right: LedgerSnapshot): number {
  if (left.measuredAt === right.measuredAt) {
    return left.id < right.id ? -1 : 1;
  }
  return left.measuredAt < right.measuredAt ? -1 : 1;
}

function freshness(measuredAt: string, asOf: string): "current" | "stale" {
  return Date.parse(asOf) - Date.parse(measuredAt) > STALE_AFTER_MS ? "stale" : "current";
}

export function separateModelIdentity(snapshot: LedgerSnapshot): ModelIdentitySeparation {
  return {
    measuredCapability: {
      checkpointDigest: snapshot.checkpointDigest,
      adapterDigest: snapshot.adapterDigest,
      modelFamily: snapshot.modelFamily,
      modelIdentifier: snapshot.modelIdentifier,
    },
    assignedModel: null,
    servingModel: null,
    historicalModelIdentity: {
      checkpointDigest: snapshot.checkpointDigest,
      adapterDigest: snapshot.adapterDigest,
    },
  };
}

export type { LedgerComparison };
