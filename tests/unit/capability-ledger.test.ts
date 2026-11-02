import { describe, expect, it } from "vitest";
import type { Actor, RoleName } from "@ai-colony/contracts";
import {
  analyzePairedRuns,
  Authorizer,
  CapabilityLedgerService,
  colonyRunContract,
  contentDigest,
  DomainError,
  holmAdjust,
  applyHolm,
  MemoryCapabilityRepository,
  pairedScoreInterval,
  permissionsForRole,
  type Persistence,
} from "@ai-colony/core";

const SCIENCE = "10000000-0000-4000-8000-000000000001";
const MATH = "10000000-0000-4000-8000-000000000002";
const WEIGHT = "10000000-0000-4000-8000-000000000003";
const MEMORY = "10000000-0000-4000-8000-000000000004";
const CEO = "10000000-0000-4000-8000-000000000006";

const departments = new Map([
  [SCIENCE, { id: SCIENCE, slug: "science" }],
  [MATH, { id: MATH, slug: "math" }],
  [WEIGHT, { id: WEIGHT, slug: "weight-optimization" }],
  [MEMORY, { id: MEMORY, slug: "memory-and-forgetting" }],
  [CEO, { id: CEO, slug: "ceo" }],
]);

function actor(role: RoleName, principalId: string, departmentId: string | null): Actor {
  return {
    principalId,
    principalType: role === "system_administrator" ? "system" : "agent",
    role,
    agentId: role === "system_administrator" ? null : principalId,
    departmentId,
    permissions: permissionsForRole(role),
  };
}

function serviceFor(store: MemoryCapabilityRepository) {
  return new CapabilityLedgerService(
    { repos: { capability: store, departments: { async findById(id: string) { return departments.get(id) ?? null; } } } } as unknown as Persistence,
    new Authorizer(),
  );
}

function manifest(itemCount: number, overrides: Partial<Parameters<typeof colonyRunContract>[0]> = {}) {
  return colonyRunContract({
    runId: "run-1",
    recordedAt: "2026-11-02T00:00:00.000Z",
    family: "gemma-3",
    identifier: "gemma-3-270m",
    alias: "Gemma 3 270M",
    checkpointId: "checkpoint-1",
    checkpointDigest: contentDigest("checkpoint"),
    adapterId: "adapter-1",
    adapterVersion: "v1",
    adapterDigest: contentDigest("adapter-a"),
    quantization: "4bit",
    backendId: "mlx",
    backendVersion: "0.32.2",
    benchmarkId: "arithmetic-suite",
    benchmarkVersion: "1",
    itemSetFingerprint: contentDigest("shared-items"),
    itemCount,
    promptTemplateDigest: contentDigest("prompt"),
    scorerId: "arithmetic",
    scorerVersion: "m6-equation-v1",
    maxOutputTokens: 128,
    temperature: 0,
    contextWindow: 2048,
    ...overrides,
  }).candidate;
}

function outcomes(flags: boolean[]) {
  return flags.map((correct, index) => ({
    itemId: `item-${index}`,
    contentDigest: contentDigest(`item-${index}`),
    correct,
    valid: true,
  }));
}

async function approvedDepartment() {
  const store = new MemoryCapabilityRepository();
  const service = serviceFor(store);
  const science = actor("department_agent", "science-principal", SCIENCE);
  const math = actor("department_agent", "math-principal", MATH);
  const weight = actor("department_agent", "weight-principal", WEIGHT);
  const memory = actor("department_agent", "memory-principal", MEMORY);
  const ceo = actor("ceo_agent", "ceo-principal", CEO);
  const proposer = actor("system_administrator", "admin-proposer", null);
  const approver = actor("system_administrator", "admin-approver", null);
  const biology = await service.registerTopic({ actor: science, correlationId: "c" }, { departmentId: SCIENCE, provenance: "science proposal" });
  const virology = await service.registerTopic({ actor: science, correlationId: "c" }, { departmentId: SCIENCE, provenance: "science proposal" });
  const arithmetic = await service.registerTopic({ actor: math, correlationId: "c" }, { departmentId: MATH, provenance: "math proposal" });
  const proposal = await service.proposeTaxonomy({ actor: science, correlationId: "c" }, {
    departmentId: SCIENCE,
    nodes: [
      { topicId: biology.id, parentTopicId: null, name: "Biology", description: null, status: "active", crossLinks: [arithmetic.id] },
      { topicId: virology.id, parentTopicId: biology.id, name: "Virology", description: "viruses", status: "active", crossLinks: [] },
    ],
  });
  const decided = await service.decideTaxonomy({ actor: approver, correlationId: "c" }, proposal.id, "approved");
  const items = outcomes(Array.from({ length: 30 }, () => true)).map((item) => ({
    itemId: item.itemId,
    contentDigest: item.contentDigest,
    topicId: virology.id,
    weight: null,
    provenance: "evaluation review",
  }));
  const mappingProposal = await service.proposeMapping({ actor: science, correlationId: "c" }, {
    departmentId: SCIENCE,
    taxonomyVersionId: decided.version?.id ?? "",
    items,
  });
  const mapping = await service.decideMapping({ actor: approver, correlationId: "c" }, mappingProposal.id, "approved");
  return { store, service, science, math, weight, memory, ceo, proposer, approver, biology, virology, arithmetic, version: decided.version, mapping: mapping.version };
}

describe("department capability ledger", () => {
  it("keeps topic identity stable across rename and records a new taxonomy version", async () => {
    const world = await approvedDepartment();
    const renamed = await world.service.recordTopicEvent({ actor: world.science, correlationId: "c" }, world.virology.id, { eventType: "rename", name: "Virus biology" });
    expect(renamed.topicId).toBe(world.virology.id);
    const second = await world.service.proposeTaxonomy({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      nodes: [
        { topicId: world.biology.id, parentTopicId: null, name: "Biology", description: null, status: "active", crossLinks: [] },
        { topicId: world.virology.id, parentTopicId: world.biology.id, name: "Virus biology", description: "viruses", status: "active", crossLinks: [] },
      ],
    });
    const approved = await world.service.decideTaxonomy({ actor: world.approver, correlationId: "c" }, second.id, "approved");
    expect(approved.version?.version).toBe(2);
    const versions = await world.service.listTaxonomyVersions({ actor: world.science, correlationId: "c" }, SCIENCE);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
  });

  it("reconstructs parent links, cross-links, renames, and deprecations from the version that was active", async () => {
    const world = await approvedDepartment();
    const current = await world.service.getTaxonomy({ actor: world.science, correlationId: "c" }, world.version?.id ?? "");
    const virology = current.tree.find((node) => node.topicId === world.virology.id);
    expect(virology?.parentTopicId).toBe(world.biology.id);
    expect(virology?.name).toBe("Virology");
    const link = current.tree.find((node) => node.topicId === world.biology.id)?.crossLinks[0];
    expect(link).toEqual({ topicId: world.arithmetic.id, departmentId: MATH, grantsMemoryAccess: false });
    const next = await world.service.proposeTaxonomy({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      nodes: [
        { topicId: world.biology.id, parentTopicId: null, name: "Life science", description: null, status: "deprecated", crossLinks: [] },
        { topicId: world.virology.id, parentTopicId: null, name: "Virology", description: null, status: "active", crossLinks: [] },
      ],
    });
    const approved = await world.service.decideTaxonomy({ actor: world.approver, correlationId: "c" }, next.id, "approved");
    const historical = await world.service.getTaxonomy({ actor: world.science, correlationId: "c" }, world.version?.id ?? "");
    const later = await world.service.getTaxonomy({ actor: world.science, correlationId: "c" }, approved.version?.id ?? "");
    expect(historical.tree.find((node) => node.topicId === world.biology.id)).toMatchObject({ name: "Biology", status: "active" });
    expect(historical.tree.find((node) => node.topicId === world.virology.id)?.parentTopicId).toBe(world.biology.id);
    expect(later.tree.find((node) => node.topicId === world.biology.id)).toMatchObject({ name: "Life science", status: "deprecated" });
    expect(later.tree.find((node) => node.topicId === world.virology.id)?.parentTopicId).toBeNull();
  });

  it("rejects hierarchy cycles and topics owned by another department", async () => {
    const world = await approvedDepartment();
    await expect(world.service.proposeTaxonomy({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      nodes: [
        { topicId: world.biology.id, parentTopicId: world.virology.id, name: "Biology", description: null, status: "active", crossLinks: [] },
        { topicId: world.virology.id, parentTopicId: world.biology.id, name: "Virology", description: null, status: "active", crossLinks: [] },
      ],
    })).rejects.toBeInstanceOf(DomainError);
    await expect(world.service.proposeTaxonomy({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      nodes: [{ topicId: world.arithmetic.id, parentTopicId: null, name: "Arithmetic", description: null, status: "active", crossLinks: [] }],
    })).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    await expect(world.service.proposeMapping({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      taxonomyVersionId: world.version?.id ?? "",
      items: [{ itemId: "foreign", contentDigest: contentDigest("foreign"), topicId: world.arithmetic.id, weight: null, provenance: "science" }],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps mapping versions isolated and refuses unapproved or cross-department scoring", async () => {
    const world = await approvedDepartment();
    const flags = Array.from({ length: 30 }, () => true);
    const second = await world.service.proposeMapping({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      taxonomyVersionId: world.version?.id ?? "",
      items: outcomes(flags).map((item) => ({ itemId: item.itemId, contentDigest: item.contentDigest, topicId: world.virology.id, weight: 0.25, provenance: "remap" })),
    });
    const approved = await world.service.decideMapping({ actor: world.approver, correlationId: "c" }, second.id, "approved");
    expect(approved.version?.id).not.toBe(world.mapping?.id);
    const firstItems = await world.store.listMappings(world.mapping?.id ?? "");
    expect(firstItems.every((item) => item.weight === null)).toBe(true);
    await expect(world.service.certifySnapshot({ actor: world.science, correlationId: "c" }, scoreInput(world, flags, manifest(30)))).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    await expect(world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, flags, { contractVersion: "nope" }),
    })).rejects.toMatchObject({ code: "EVALUATION_FAILED" });
    await expect(world.service.certifySnapshot({ actor: world.math, correlationId: "c" }, scoreInput(world, flags, manifest(30)))).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it("appends immutable snapshots and does not treat an untested topic as zero", async () => {
    const world = await approvedDepartment();
    const flags = Array.from({ length: 30 }, (_, index) => index < 15);
    const older = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, flags, manifest(30, { runId: "run-old", recordedAt: "2026-10-01T00:00:00.000Z" })),
      measuredAt: "2026-10-01T00:00:00.000Z",
    });
    const newer = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, flags.map(() => true), manifest(30, { runId: "run-new", adapterDigest: contentDigest("adapter-b"), recordedAt: "2026-11-01T00:00:00.000Z" })),
      measuredAt: "2026-11-01T00:00:00.000Z",
    });
    expect(older.id).not.toBe(newer.id);
    expect(world.store.snapshots).toHaveLength(2);
    await expect(world.store.insertSnapshot(older)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(older.accuracy).toBe(0.5);
    const [firstItem, secondItem] = outcomes([true, false]);
    if (!firstItem || !secondItem) {
      throw new Error("expected two benchmark items");
    }
    const smallProposal = await world.service.proposeMapping({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      taxonomyVersionId: world.version?.id ?? "",
      items: [
        { itemId: firstItem.itemId, contentDigest: firstItem.contentDigest, topicId: world.virology.id, weight: 0.1, provenance: "review" },
        { itemId: secondItem.itemId, contentDigest: secondItem.contentDigest, topicId: world.virology.id, weight: 0.9, provenance: "review" },
      ],
    });
    const small = await world.service.decideMapping({ actor: world.approver, correlationId: "c" }, smallProposal.id, "approved");
    const uneven = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, [true, false], manifest(2, { runId: "run-weight", itemCount: 2 })),
      mappingVersionId: small.version?.id ?? "",
      measuredAt: "2026-11-02T00:00:00.000Z",
    });
    expect(uneven.accuracy).toBe(0.5);
    const overview = await world.service.overview({ actor: world.science, correlationId: "c" }, SCIENCE, world.version?.id ?? "", new Date("2026-11-02T00:00:00.000Z"));
    expect(overview.topics.find((topic) => topic.topicId === world.biology.id)?.coverage).toBe("untested");
    expect(overview.untestedTopics).toContain(world.biology.id);
    expect(overview.topics.find((topic) => topic.topicId === world.biology.id)?.latest).toBeNull();
    expect(newer.accuracy).toBe(1);
    expect(overview.topics.find((topic) => topic.topicId === world.virology.id)?.latest?.id).toBe(uneven.id);
    expect(overview.topics.find((topic) => topic.topicId === world.virology.id)?.latest?.accuracy).toBe(0.5);
    expect(overview.assignedModel).toBeNull();
    expect(overview.servingModel).toBeNull();
    expect(overview.topics.find((topic) => topic.topicId === world.virology.id)?.freshness).toBe("current");
  });

  it("reuses the evaluation contract and withholds improvement claims from noncomparable or inconclusive pairs", async () => {
    const world = await approvedDepartment();
    const improvedFlags = Array.from({ length: 30 }, () => true);
    const baseline = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, improvedFlags.map(() => false), manifest(30, { runId: "base", adapterId: "base", adapterDigest: contentDigest("base") })),
      measuredAt: "2026-10-01T00:00:00.000Z",
    });
    const candidate = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, improvedFlags, manifest(30, { runId: "next", adapterId: "next", adapterDigest: contentDigest("next") })),
      measuredAt: "2026-11-01T00:00:00.000Z",
    });
    const matched = await world.service.compare({ actor: world.approver, correlationId: "c" }, { baselineId: baseline.id, candidateId: candidate.id });
    const contract = analyzePairedRuns({
      baseline: baseline.manifest,
      candidate: candidate.manifest,
      items: baseline.items.map((item, index) => ({
        itemId: item.itemId,
        contentDigest: item.contentDigest,
        baselineCorrect: item.correct,
        candidateCorrect: candidate.items[index]?.correct ?? null,
        baselineValid: true,
        candidateValid: true,
      })),
    });
    expect(contract.pairedInterval).toEqual({ low: 1, high: 1 });
    expect(matched.rawPValue).toBe(contract.pValue);
    expect(matched.verdict).toBe("improvement");
    expect(matched.interval?.low).toBeGreaterThan(0);
    expect(matched.interval?.low).toBeLessThan(1);
    expect(matched.waldInterval).toEqual({ low: 1, high: 1 });
    expect(matched.attribution.catastrophicForgetting).toBe(false);
    expect(matched.attribution.cause).toBe("not_attributed");
    expect(matched.deploymentAuthorization).toBe("separate_decision_required");
    const shifted = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, improvedFlags, manifest(30, { runId: "short", maxOutputTokens: 8 })),
      measuredAt: "2026-11-03T00:00:00.000Z",
    });
    const blocked = await world.service.compare({ actor: world.approver, correlationId: "c" }, { baselineId: baseline.id, candidateId: shifted.id });
    expect(blocked.verdict).toBe("noncomparable");
    expect(blocked.absoluteDifference).toBeNull();
    const tied = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, improvedFlags.map(() => false), manifest(30, { runId: "tied", adapterDigest: contentDigest("tied") })),
      measuredAt: "2026-11-04T00:00:00.000Z",
    });
    const inconclusive = await world.service.compare({ actor: world.approver, correlationId: "c" }, { baselineId: baseline.id, candidateId: tied.id });
    expect(inconclusive.verdict).toBe("inconclusive");
    const otherMapping = await world.service.proposeMapping({ actor: world.science, correlationId: "c" }, {
      departmentId: SCIENCE,
      taxonomyVersionId: world.version?.id ?? "",
      items: outcomes(improvedFlags).map((item) => ({ itemId: item.itemId, contentDigest: item.contentDigest, topicId: world.virology.id, weight: null, provenance: "new map" })),
    });
    const approvedMap = await world.service.decideMapping({ actor: world.approver, correlationId: "c" }, otherMapping.id, "approved");
    const remapped = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, improvedFlags, manifest(30, { runId: "remap", adapterDigest: contentDigest("remap") })),
      mappingVersionId: approvedMap.version?.id ?? "",
      measuredAt: "2026-11-05T00:00:00.000Z",
    });
    const silent = await world.service.compare({ actor: world.approver, correlationId: "c" }, { baselineId: candidate.id, candidateId: remapped.id });
    expect(silent.verdict).toBe("noncomparable");
    const designed = await world.service.compare({ actor: world.approver, correlationId: "c" }, {
      baselineId: candidate.id,
      candidateId: remapped.id,
      commonItemDesign: true,
    });
    expect(designed.verdict).toBe("inconclusive");
  });

  it("adjusts multiple topic tests with Holm and separates stale evidence from coverage", async () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03]);
    expect(adjusted[0]).toBeCloseTo(0.03);
    expect(adjusted[1]).toBeCloseTo(0.06);
    expect(adjusted[2]).toBeCloseTo(0.06);
    const rows = applyHolm([
      { rawPValue: 0.01, verdict: "improvement" as const, interval: { low: 0.2, high: 0.4 }, absoluteDifference: 0.3 },
      { rawPValue: 0.04, verdict: "improvement" as const, interval: { low: 0.1, high: 0.2 }, absoluteDifference: 0.1 },
      { rawPValue: 0.03, verdict: "improvement" as const, interval: { low: 0.1, high: 0.2 }, absoluteDifference: 0.1 },
    ]);
    expect(rows[0]?.verdict).toBe("improvement");
    expect(rows[1]?.verdict).toBe("inconclusive");
    expect(rows[1]?.adjustedPValue).toBeCloseTo(0.06);
    expect(rows[2]?.verdict).toBe("inconclusive");
    expect(holmAdjust([0.01, null])[1]).toBeNull();
    const extreme = pairedScoreInterval(30, 0, 30);
    expect(extreme.low).toBeGreaterThan(0);
    expect(extreme.low).toBeLessThan(1);
    expect(extreme.high).toBe(1);
    const world = await approvedDepartment();
    const oldFlags = Array.from({ length: 30 }, () => false);
    const newFlags = Array.from({ length: 30 }, () => true);
    await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, oldFlags, manifest(30, { runId: "old" })),
      measuredAt: "2024-01-01T00:00:00.000Z",
    });
    await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, {
      ...scoreInput(world, newFlags, manifest(30, { runId: "new", adapterDigest: contentDigest("later") })),
      measuredAt: "2024-02-01T00:00:00.000Z",
    });
    const overview = await world.service.overview({ actor: world.weight, correlationId: "c" }, SCIENCE, world.version?.id ?? "", new Date("2026-11-02T00:00:00.000Z"));
    expect(overview.topics.find((topic) => topic.topicId === world.virology.id)?.freshness).toBe("stale");
    expect(overview.comparisons).toHaveLength(1);
    expect(overview.comparisons[0]?.verdict).toBe("improvement");
    expect(overview.comparisons[0]?.adjustedPValue).toBe(overview.comparisons[0]?.rawPValue);
    expect(overview.possibleRegressions).toEqual([]);
    await expect(world.service.overview({ actor: world.math, correlationId: "c" }, SCIENCE, world.version?.id ?? "")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it("enforces proposal, approval, certification, and retention boundaries", async () => {
    const world = await approvedDepartment();
    const self = await world.service.proposeTaxonomy({ actor: world.proposer, correlationId: "c" }, {
      departmentId: SCIENCE,
      nodes: [
        { topicId: world.biology.id, parentTopicId: null, name: "Biology", description: null, status: "active", crossLinks: [] },
        { topicId: world.virology.id, parentTopicId: world.biology.id, name: "Virology", description: null, status: "active", crossLinks: [] },
      ],
    });
    await expect(world.service.decideTaxonomy({ actor: world.proposer, correlationId: "c" }, self.id, "approved")).rejects.toMatchObject({ code: "SELF_APPROVAL" });
    await expect(world.service.decideTaxonomy({ actor: world.ceo, correlationId: "c" }, self.id, "approved")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    await expect(world.service.decideMapping({ actor: world.approver, correlationId: "c" }, self.id, "approved")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const flags = Array.from({ length: 30 }, () => true);
    const snapshot = await world.service.certifySnapshot({ actor: world.approver, correlationId: "c" }, scoreInput(world, flags, manifest(30)));
    await expect(world.service.recordRetention({ actor: world.science, correlationId: "c" }, snapshot.id, { action: "revoke", reason: "department request" })).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    await world.service.recordRetention({ actor: world.memory, correlationId: "c" }, snapshot.id, { action: "revoke", reason: "privacy" });
    await expect(world.service.getSnapshot({ actor: world.science, correlationId: "c" }, snapshot.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const hidden = await world.service.getSnapshot({ actor: world.approver, correlationId: "c" }, snapshot.id);
    expect(hidden.snapshot.id).toBe(snapshot.id);
    expect(hidden.modelIdentity.assignedModel).toBeNull();
    expect(hidden.modelIdentity.servingModel).toBeNull();
    expect(hidden.modelIdentity.historicalModelIdentity.checkpointDigest).toBe(snapshot.checkpointDigest);
    await expect(world.service.history({ actor: world.math, correlationId: "c" }, { departmentId: SCIENCE })).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    const weightView = await world.service.history({ actor: world.weight, correlationId: "c" }, { departmentId: SCIENCE });
    expect(weightView.some((row) => row.id === snapshot.id)).toBe(false);
  });
});

function scoreInput(world: Awaited<ReturnType<typeof approvedDepartment>>, flags: boolean[], manifestValue: unknown) {
  const items = outcomes(flags);
  return {
    departmentId: SCIENCE,
    topicId: world.virology.id,
    taxonomyVersionId: world.version?.id ?? "",
    mappingVersionId: world.mapping?.id ?? "",
    evidenceRef: "evaluation-evidence",
    manifest: manifestValue,
    measuredAt: "2026-11-02T00:00:00.000Z",
    correctCount: flags.filter(Boolean).length,
    incorrectCount: flags.filter((flag) => !flag).length,
    failureClasses: { format: flags.filter((flag) => !flag).length },
    measurementMode: "closed_book" as const,
    capabilityKind: "model" as const,
    items,
    provenance: "evaluation certification",
  };
}
