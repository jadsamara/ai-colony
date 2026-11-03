import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resourceBudgetSchema, SPECIFICATION_VERSION, type Actor } from "@ai-colony/contracts";
import {
  Authorizer,
  CapabilityLedgerService,
  colonyRunContract,
  contentDigest,
  parseEvaluationManifest,
  type RequestContext,
} from "@ai-colony/core";
import {
  assertDisposableDatabaseUrl,
  assessLedgerReadiness,
  createDatabase,
  createPersistence,
  createReadOnlyInspection,
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

function context(role: Actor["role"], departmentId: string | null, principalId: string = randomUUID()): RequestContext {
  return {
    correlationId: "m9.1",
    actor: {
      principalId,
      principalType: role === "system_administrator" ? "system" : "agent",
      role,
      agentId: role === "system_administrator" ? null : principalId,
      departmentId,
      permissions: [],
    },
  };
}

const budget = resourceBudgetSchema.parse({
  maxConcurrentExecutions: 1,
  maxCpuAllocation: { value: 100, unit: "millicores" },
  maxGpuAllocation: { value: 0, unit: "devices" },
  maxMemoryAllocation: { value: 256, unit: "mebibytes" },
  maxEstimatedComputeExpenditure: { value: 0, unit: "usd_micros" },
  maxTrainingExpenditure: { value: 0, unit: "usd_micros" },
  maxModelParameterCount: { value: 0, unit: "parameters" },
  resetPeriod: null,
  expiresAt: null,
});

const databaseUrl = process.env.LEDGER_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("ledger activation", () => {
  it("applies migration 0009 once, certifies through governance, and stays immutable", async () => {
    if (!databaseUrl) {
      return;
    }
    assertDisposableDatabaseUrl(databaseUrl);
    const { db, close } = createDatabase(databaseUrl);
    try {
      await migrateDatabase(db);
      await migrateDatabase(db);
      const migrations = await db.execute<{ created_at: string }>(
        sql`select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at`,
      );
      const applied = (Array.isArray(migrations) ? migrations : []).map((row) => row.created_at);
      expect(applied.filter((value) => value === "1793551000000")).toHaveLength(1);
      expect(applied.filter((value) => value === "1793552000000")).toHaveLength(1);
      const tables = await db.execute<{ table_name: string }>(sql`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name like 'ledger_%'
      `);
      expect((Array.isArray(tables) ? tables : []).map((row) => row.table_name).sort()).toEqual([
        "ledger_decisions",
        "ledger_mapping_versions",
        "ledger_proposals",
        "ledger_retention_events",
        "ledger_snapshots",
        "ledger_taxonomy_edges",
        "ledger_taxonomy_versions",
        "ledger_topic_events",
        "ledger_topic_mappings",
        "ledger_topics",
      ]);

      const scienceId = randomUUID();
      const evaluationId = randomUUID();
      const mathId = randomUUID();
      for (const department of [
        [scienceId, "science"],
        [evaluationId, "evaluation"],
        [mathId, "math"],
      ] as const) {
        await db.insert(schema.departments).values({
          id: department[0],
          name: `Activation ${department[1]}`,
          slug: `${department[1]}-${department[0].slice(0, 8)}`,
          description: "Disposable ledger activation department",
          purpose: "Exercise the capability lifecycle away from canonical data",
          parentDepartmentId: null,
          status: "active",
          departmentType: "specialized",
          creationSource: "api",
          createdBy: "m9.1-test",
          resourceBudget: budget,
          policyRef: null,
          metadata: {},
          specificationVersion: SPECIFICATION_VERSION,
        });
      }
      const memoryId = randomUUID();
      await db.insert(schema.departments).values({
        id: memoryId,
        name: "Memory",
        slug: "memory-and-forgetting",
        description: "Disposable retention department",
        purpose: "Exercise retention away from canonical data",
        parentDepartmentId: null,
        status: "active",
        departmentType: "specialized",
        creationSource: "api",
        createdBy: "m9.1-test",
        resourceBudget: budget,
        policyRef: null,
        metadata: {},
        specificationVersion: SPECIFICATION_VERSION,
      });

      const persistence = createPersistence(db, async () => undefined);
      const ledger = new CapabilityLedgerService(persistence, new Authorizer());
      const science = context("department_agent", scienceId);
      const evaluation = context("department_agent", evaluationId);
      const math = context("department_agent", mathId);
      const memoryActor = context("department_agent", memoryId);
      const admin = context("system_administrator", null);
      const ceo = context("ceo_agent", randomUUID());

      await expect(ledger.registerTopic(math, { departmentId: scienceId, provenance: "Borrowed" })).rejects.toMatchObject({
        code: "AUTHORIZATION_DENIED",
      });
      const root = await ledger.registerTopic(science, { departmentId: scienceId, provenance: "Science root" });
      const child = await ledger.registerTopic(science, { departmentId: scienceId, provenance: "Arithmetic" });
      const untouched = await ledger.registerTopic(science, { departmentId: scienceId, provenance: "Untouched" });
      const proposal = await ledger.proposeTaxonomy(science, {
        departmentId: scienceId,
        nodes: [
          { topicId: root.id, parentTopicId: null, name: "Science", description: "Root", status: "active", crossLinks: [] },
          { topicId: child.id, parentTopicId: root.id, name: "Arithmetic", description: "Child", status: "active", crossLinks: [] },
          { topicId: untouched.id, parentTopicId: root.id, name: "Untouched", description: "No score", status: "active", crossLinks: [] },
        ],
      });
      await expect(ledger.decideTaxonomy(science, proposal.id, "approved")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      await expect(ledger.decideTaxonomy(ceo, proposal.id, "approved")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      await expect(
        ledger.decideTaxonomy(context("system_administrator", null, science.actor.principalId), proposal.id, "approved"),
      ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
      const taxonomy = await ledger.decideTaxonomy(admin, proposal.id, "approved");
      expect(taxonomy.version?.version).toBe(1);
      const earlier = await ledger.getTaxonomy(admin, taxonomy.version?.id ?? "");
      expect(earlier.tree).toHaveLength(3);

      const digest = contentDigest("synthetic-item");
      const secondDigest = contentDigest("synthetic-item-2");
      const mapping = await ledger.proposeMapping(science, {
        departmentId: scienceId,
        taxonomyVersionId: taxonomy.version?.id ?? "",
        items: [
          { topicId: child.id, itemId: "item-1", contentDigest: digest, weight: null, provenance: "synthetic benchmark item" },
          { topicId: child.id, itemId: "item-2", contentDigest: secondDigest, weight: null, provenance: "synthetic benchmark item" },
        ],
      });
      await expect(ledger.decideMapping(science, mapping.id, "approved")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      const approvedMapping = await ledger.decideMapping(admin, mapping.id, "approved");
      const changed = await ledger.proposeMapping(science, {
        departmentId: scienceId,
        taxonomyVersionId: taxonomy.version?.id ?? "",
        items: [{ topicId: child.id, itemId: "item-1", contentDigest: digest, weight: null, provenance: "synthetic benchmark item" }],
      });
      const nextMapping = await ledger.decideMapping(admin, changed.id, "approved");
      expect(nextMapping.version?.version).toBe(2);
      expect((await persistence.repos.capability.listMappings(approvedMapping.version?.id ?? "")).length).toBe(2);

      const candidate = colonyRunContract({
        runId: randomUUID(),
        recordedAt: "2026-11-02T00:00:00.000Z",
        family: "qwen3",
        identifier: "qwen3-8b",
        alias: "Qwen3-8B",
        checkpointId: "checkpoint-synthetic",
        checkpointDigest: contentDigest("checkpoint"),
        adapterId: "adapter-synthetic",
        adapterVersion: "v0",
        adapterDigest: contentDigest("adapter"),
        quantization: "none",
        backendId: "synthetic-backend",
        backendVersion: "0",
        benchmarkId: "synthetic-benchmark",
        benchmarkVersion: "1",
        itemSetFingerprint: contentDigest("synthetic-items"),
        itemCount: 2,
        promptTemplateDigest: contentDigest("prompt"),
        scorerId: "synthetic-scorer",
        scorerVersion: "m9.1",
        maxOutputTokens: 128,
        temperature: 0,
        contextWindow: 2048,
      }).candidate;
      const manifest = parseEvaluationManifest({
        ...candidate,
        execution: { ...candidate.execution, provenance: { state: "set", value: "synthetic" } },
      });
      const measured = {
        departmentId: scienceId,
        topicId: child.id,
        taxonomyVersionId: taxonomy.version?.id ?? "",
        mappingVersionId: approvedMapping.version?.id ?? "",
        evidenceRef: "synthetic:activation-score",
        manifest,
        measuredAt: "2026-11-02T00:00:00.000Z",
        correctCount: 2,
        incorrectCount: 0,
        failureClasses: { arithmetic: 0 },
        measurementMode: "closed_book" as const,
        capabilityKind: "model" as const,
        items: [
          { itemId: "item-1", contentDigest: digest, correct: true, valid: true },
          { itemId: "item-2", contentDigest: secondDigest, correct: true, valid: true },
        ],
        provenance: "synthetic fixture; this is not observed model performance",
      };
      await expect(ledger.certifySnapshot(science, measured)).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      await expect(ledger.certifySnapshot(evaluation, measured)).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      const unlabeled = { ...measured, evidenceRef: "activation-score", provenance: "unlabeled fixture" };
      await expect(ledger.certifySnapshot(admin, unlabeled)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const measurement = await ledger.proposeMeasurement(science, measured);
      const review = await ledger.reviewMeasurement(admin, measurement.id);
      expect(review.synthetic).toBe(true);
      expect(review.certifiable).toBe(true);
      expect(review.manifest?.model.family).toMatchObject({ state: "set", value: "qwen3" });
      await expect(ledger.decideMeasurement(science, measurement.id, "approved")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      await expect(ledger.decideMeasurement(evaluation, measurement.id, "approved")).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      const certified = await ledger.decideMeasurement(admin, measurement.id, "approved");
      expect(certified.snapshot?.provenance).toContain("synthetic");
      expect(certified.snapshot?.certifiedBy).toBe(admin.actor.principalId);
      expect(certified.repeated).toBe(false);
      const repeated = await ledger.certifySnapshot(admin, measured);
      expect(repeated.id).toBe(certified.snapshot?.id);
      const duplicateProposal = await ledger.proposeMeasurement(science, measured);
      const duplicate = await ledger.decideMeasurement(admin, duplicateProposal.id, "approved");
      expect(duplicate.repeated).toBe(true);
      expect(duplicate.snapshot?.id).toBe(certified.snapshot?.id);
      await expect(ledger.decideMeasurement(admin, measurement.id, "approved")).rejects.toMatchObject({ code: "CONFLICT" });

      const weaker = await ledger.certifySnapshot(admin, {
        ...measured,
        evidenceRef: "synthetic:activation-later",
        measuredAt: "2026-11-02T01:00:00.000Z",
        correctCount: 1,
        incorrectCount: 1,
        items: [
          { itemId: "item-1", contentDigest: digest, correct: true, valid: true },
          { itemId: "item-2", contentDigest: secondDigest, correct: false, valid: true },
        ],
      });
      const overview = await ledger.overview(admin, scienceId, taxonomy.version?.id ?? "");
      const arithmetic = overview.topics.find((topic) => topic.topicId === child.id);
      expect(arithmetic?.latest?.id).toBe(weaker.id);
      expect(arithmetic?.latest?.accuracy).toBeLessThan(1);
      expect(overview.untestedTopics).toContain(untouched.id);
      expect(overview.note).toContain("not a best score");
      const history = await ledger.history(science, { departmentId: scienceId, topicId: child.id });
      expect(history.map((row) => row.id)).toEqual([certified.snapshot?.id, weaker.id]);
      await expect(ledger.history(math, { departmentId: scienceId })).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });

      await expect(ledger.recordRetention(science, weaker.id, { action: "revoke", reason: "not this department" })).rejects.toMatchObject({
        code: "AUTHORIZATION_DENIED",
      });
      await ledger.recordRetention(admin, weaker.id, { action: "retain", reason: "Keep the synthetic fixture" });
      await ledger.recordRetention(admin, weaker.id, { action: "archive", reason: "Archive the synthetic fixture" });
      expect((await ledger.getSnapshot(science, weaker.id)).snapshot.id).toBe(weaker.id);
      await ledger.recordRetention(memoryActor, weaker.id, { action: "revoke", reason: "Hide the synthetic fixture" });
      await expect(ledger.getSnapshot(science, weaker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await ledger.getSnapshot(admin, weaker.id)).snapshot.id).toBe(weaker.id);
      const retained = await persistence.repos.capability.listRetention(weaker.id);
      expect(retained.map((event) => event.action)).toEqual(["retain", "archive", "revoke"]);

      const snapshotId = certified.snapshot?.id ?? "";
      await expect(db.execute(sql`update ledger_snapshots set accuracy = 0 where id = ${snapshotId}::uuid`)).rejects.toSatisfy((error: unknown) =>
        errorText(error).includes("immutable"),
      );
      await expect(db.execute(sql`delete from ledger_snapshots where id = ${snapshotId}::uuid`)).rejects.toSatisfy((error: unknown) =>
        errorText(error).includes("immutable"),
      );
      const failedId = randomUUID();
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(schema.ledgerTopics).values({
            id: failedId,
            departmentId: scienceId,
            provenance: "Rolled back",
            createdBy: science.actor.principalId,
          });
          throw new Error("activation rollback");
        }),
      ).rejects.toThrow(/activation rollback/);
      expect(await persistence.repos.capability.findTopic(failedId)).toBeNull();

      const beforeAuthority = await assessLedgerReadiness(databaseUrl);
      expect(beforeAuthority.status).toBe("partial");
      expect(beforeAuthority.missingMigrations).toEqual([]);
      expect(beforeAuthority.certificationAuthority).toBe("not_demonstrated");
      await db.insert(schema.roles).values([
        { name: "system_administrator", description: "Administrator" },
        { name: "department_agent", description: "Department" },
      ]);
      await db.insert(schema.permissions).values([
        { name: "evaluation:suite:approve", description: "Certify" },
        { name: "capability:approve", description: "Approve taxonomy" },
        { name: "learning:propose", description: "Propose" },
      ]);
      await db.insert(schema.rolePermissions).values([
        { roleName: "system_administrator", permissionName: "evaluation:suite:approve" },
        { roleName: "system_administrator", permissionName: "capability:approve" },
        { roleName: "department_agent", permissionName: "learning:propose" },
      ]);
      await db.insert(schema.principals).values({
        id: admin.actor.principalId,
        principalType: "system",
        displayName: "Activation administrator",
        roleName: "system_administrator",
        agentId: null,
      });
      const ready = await assessLedgerReadiness(databaseUrl);
      expect(ready.status).toBe("operational");
      expect(ready.readOnly).toBe(true);
      expect(ready.certificationAuthority).toBe("demonstrated");
      expect(ready.governancePath).toBe("demonstrated");
      expect(ready.evaluationContract).toBe("m8.2-evaluation-contract-v1");
      expect(ready.apiRunning).toBe("not_checked");
      const inspection = createReadOnlyInspection(databaseUrl);
      try {
        await inspection.assertReadOnly();
        const count = await inspection.sql<{ count: string }[]>`select count(*)::text as count from ledger_snapshots`;
        expect(Number(count[0]?.count)).toBe(2);
      } finally {
        await inspection.close();
      }
    } finally {
      await close();
    }
  });
});
