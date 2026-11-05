import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resourceBudgetSchema, SPECIFICATION_VERSION } from "@ai-colony/contracts";
import { colonyRunContract, contentDigest, SNAPSHOT_SCHEMA_VERSION, type LedgerSnapshot } from "@ai-colony/core";
import {
  assertDisposableDatabaseUrl,
  createDatabase,
  createPersistence,
  migrateDatabase,
  schema,
} from "@ai-colony/database";

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("message" in current && typeof current.message === "string") {
      parts.push(current.message);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return parts.join("\n");
}

const databaseUrl = process.env.LEDGER_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("capability ledger database", () => {
  it("migrates on an isolated database and rejects snapshot mutation", async () => {
    if (!databaseUrl) {
      return;
    }
    assertDisposableDatabaseUrl(databaseUrl);
    const { db, close } = createDatabase(databaseUrl);
    try {
      await migrateDatabase(db);
      const departmentId = randomUUID();
      await db.insert(schema.departments).values({
        id: departmentId,
        name: `Ledger ${departmentId.slice(0, 8)}`,
        slug: `ledger-${departmentId.slice(0, 8)}`,
        description: "Isolated ledger test department",
        purpose: "Prove ledger constraints without touching canonical data",
        parentDepartmentId: null,
        status: "active",
        departmentType: "specialized",
        creationSource: "api",
        createdBy: "m9-test",
        resourceBudget: resourceBudgetSchema.parse({
          maxConcurrentExecutions: 1,
          maxCpuAllocation: { value: 100, unit: "millicores" },
          maxGpuAllocation: { value: 0, unit: "devices" },
          maxMemoryAllocation: { value: 256, unit: "mebibytes" },
          maxEstimatedComputeExpenditure: { value: 0, unit: "usd_micros" },
          maxTrainingExpenditure: { value: 0, unit: "usd_micros" },
          maxModelParameterCount: { value: 0, unit: "parameters" },
          resetPeriod: null,
          expiresAt: null,
        }),
        policyRef: null,
        metadata: {},
        specificationVersion: SPECIFICATION_VERSION,
      });
      const persistence = createPersistence(db, async () => undefined);
      const topicId = randomUUID();
      await persistence.repos.capability.insertTopic({
        id: topicId,
        departmentId,
        createdBy: "m9-test",
        createdAt: new Date().toISOString(),
        provenance: "isolated test",
      });
      await expect(db.execute(sql`update ledger_topics set provenance = 'changed' where id = ${topicId}`)).rejects.toSatisfy((error: unknown) => /immutable/.test(errorText(error)));
      await expect(db.execute(sql`delete from ledger_topics where id = ${topicId}`)).rejects.toSatisfy((error: unknown) => /immutable/.test(errorText(error)));
      const missing = randomUUID();
      await expect(persistence.repos.capability.insertTopic({
        id: missing,
        departmentId: randomUUID(),
        createdBy: "m9-test",
        createdAt: new Date().toISOString(),
        provenance: "missing department",
      })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
      const proposalId = randomUUID();
      const versionId = randomUUID();
      const mappingId = randomUUID();
      const snapshotId = randomUUID();
      const now = new Date().toISOString();
      await persistence.repos.capability.insertProposal({ id: proposalId, departmentId, kind: "taxonomy", payload: { nodes: [] }, proposedBy: "m9-test", createdAt: now });
      await persistence.repos.capability.insertDecision({ id: randomUUID(), proposalId, decision: "approved", decidedBy: "other", createdAt: now });
      await expect(persistence.repos.capability.insertDecision({ id: randomUUID(), proposalId, decision: "rejected", decidedBy: "third", createdAt: now })).rejects.toMatchObject({ code: "CONFLICT" });
      await persistence.repos.capability.insertTaxonomyVersion({ id: versionId, departmentId, version: 1, proposalId, createdBy: "other", createdAt: now });
      await expect(db.insert(schema.ledgerTaxonomyEdges).values({
        id: randomUUID(),
        versionId,
        topicId,
        parentTopicId: topicId,
        kind: "parent",
        name: "Cycle",
        description: null,
        status: "active",
        targetDepartmentId: null,
      })).rejects.toThrow();
      const mappingProposalId = randomUUID();
      await persistence.repos.capability.insertProposal({ id: mappingProposalId, departmentId, kind: "mapping", payload: { items: [] }, proposedBy: "m9-test", createdAt: now });
      await persistence.repos.capability.insertMappingVersion({ id: mappingId, departmentId, version: 1, taxonomyVersionId: versionId, proposalId: mappingProposalId, createdBy: "other", createdAt: now });
      const manifest = colonyRunContract({
        runId: "isolated",
        recordedAt: "2026-11-02T00:00:00.000Z",
        family: "gemma-3",
        identifier: "gemma-3-270m",
        alias: "Gemma 3 270M",
        checkpointId: "checkpoint-1",
        checkpointDigest: contentDigest("checkpoint"),
        adapterId: "adapter-1",
        adapterVersion: "v1",
        adapterDigest: contentDigest("adapter"),
        quantization: "4bit",
        backendId: "mlx",
        backendVersion: "0.32.2",
        benchmarkId: "arithmetic-suite",
        benchmarkVersion: "1",
        itemSetFingerprint: contentDigest("items"),
        itemCount: 1,
        promptTemplateDigest: contentDigest("prompt"),
        scorerId: "arithmetic",
        scorerVersion: "m6-equation-v1",
        maxOutputTokens: 128,
        temperature: 0,
        contextWindow: 2048,
      }).candidate;
      const snapshot: LedgerSnapshot = {
        id: snapshotId,
        departmentId,
        topicId,
        taxonomyVersionId: versionId,
        mappingVersionId: mappingId,
        evaluationRunId: null,
        evidenceRef: "isolated-test",
        manifestFingerprint: "a".repeat(64),
        manifest,
        modelFamily: "gemma-3",
        modelIdentifier: "gemma-3-270m",
        checkpointDigest: contentDigest("checkpoint"),
        adapterId: "adapter-1",
        adapterDigest: contentDigest("adapter"),
        measuredAt: now,
        validity: "valid",
        sampleSize: 1,
        correctCount: 1,
        incorrectCount: 0,
        failureClasses: {},
        accuracy: 1,
        uncertaintyLow: 0,
        uncertaintyHigh: 1,
        measurementMode: "closed_book",
        capabilityKind: "model",
        items: [{ itemId: "item-1", contentDigest: contentDigest("item-1"), correct: true, valid: true }],
        provenance: "isolated test",
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        certifiedBy: "other",
        createdAt: now,
      };
      await persistence.repos.capability.insertSnapshot(snapshot);
      await expect(db.execute(sql`update ledger_snapshots set accuracy = 0 where id = ${snapshotId}`)).rejects.toSatisfy((error: unknown) => /immutable/.test(errorText(error)));
      await expect(db.execute(sql`delete from ledger_snapshots where id = ${snapshotId}`)).rejects.toSatisfy((error: unknown) => /immutable/.test(errorText(error)));
      const stored = await persistence.repos.capability.findSnapshot(snapshotId);
      expect(stored?.accuracy).toBe(1);
      expect(stored?.taxonomyVersionId).toBe(versionId);
    } finally {
      await close();
    }
  });
});
