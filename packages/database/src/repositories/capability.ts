import { and, asc, eq } from "drizzle-orm";
import type {
  CapabilityRepository,
  LedgerDecision,
  LedgerEdge,
  LedgerMapping,
  LedgerMappingVersion,
  LedgerProposal,
  LedgerRetentionEvent,
  LedgerSnapshot,
  LedgerTaxonomyVersion,
  LedgerTopic,
  LedgerTopicEvent,
} from "@ai-colony/core";
import type { DbExecutor } from "../client.js";
import { guard } from "../db-error.js";
import {
  ledgerDecisions,
  ledgerMappingVersions,
  ledgerProposals,
  ledgerRetentionEvents,
  ledgerSnapshots,
  ledgerTaxonomyEdges,
  ledgerTaxonomyVersions,
  ledgerTopicEvents,
  ledgerTopicMappings,
  ledgerTopics,
} from "../schema/index.js";

function iso(value: Date): string {
  return value.toISOString();
}

export function createCapabilityRepository(db: DbExecutor): CapabilityRepository {
  return {
    async insertTopic(row) {
      await guard(() => db.insert(ledgerTopics).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async findTopic(id) {
      const [row] = await db.select().from(ledgerTopics).where(eq(ledgerTopics.id, id)).limit(1);
      return row ? mapTopic(row) : null;
    },
    async listTopics(departmentId) {
      const rows = await db.select().from(ledgerTopics).where(eq(ledgerTopics.departmentId, departmentId)).orderBy(asc(ledgerTopics.createdAt));
      return rows.map(mapTopic);
    },
    async insertTopicEvent(row) {
      await guard(() => db.insert(ledgerTopicEvents).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async listTopicEvents(topicId) {
      const rows = await db.select().from(ledgerTopicEvents).where(eq(ledgerTopicEvents.topicId, topicId)).orderBy(asc(ledgerTopicEvents.createdAt));
      return rows.map(mapEvent);
    },
    async insertProposal(row) {
      await guard(() => db.insert(ledgerProposals).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async findProposal(id) {
      const [row] = await db.select().from(ledgerProposals).where(eq(ledgerProposals.id, id)).limit(1);
      return row ? mapProposal(row) : null;
    },
    async listProposals(departmentId) {
      const rows = await db.select().from(ledgerProposals).where(eq(ledgerProposals.departmentId, departmentId)).orderBy(asc(ledgerProposals.createdAt));
      return rows.map(mapProposal);
    },
    async insertDecision(row) {
      await guard(() => db.insert(ledgerDecisions).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async findDecision(proposalId) {
      const [row] = await db.select().from(ledgerDecisions).where(eq(ledgerDecisions.proposalId, proposalId)).limit(1);
      return row ? mapDecision(row) : null;
    },
    async insertTaxonomyVersion(row) {
      await guard(() => db.insert(ledgerTaxonomyVersions).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async listTaxonomyVersions(departmentId) {
      const rows = await db.select().from(ledgerTaxonomyVersions).where(eq(ledgerTaxonomyVersions.departmentId, departmentId)).orderBy(asc(ledgerTaxonomyVersions.version));
      return rows.map(mapVersion);
    },
    async findTaxonomyVersion(id) {
      const [row] = await db.select().from(ledgerTaxonomyVersions).where(eq(ledgerTaxonomyVersions.id, id)).limit(1);
      return row ? mapVersion(row) : null;
    },
    async insertEdges(rows) {
      if (rows.length === 0) {
        return;
      }
      await guard(() => db.insert(ledgerTaxonomyEdges).values(rows));
    },
    async listEdges(versionId) {
      const rows = await db.select().from(ledgerTaxonomyEdges).where(eq(ledgerTaxonomyEdges.versionId, versionId));
      return rows.map(mapEdge);
    },
    async insertMappingVersion(row) {
      await guard(() => db.insert(ledgerMappingVersions).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async listMappingVersions(departmentId) {
      const rows = await db.select().from(ledgerMappingVersions).where(eq(ledgerMappingVersions.departmentId, departmentId)).orderBy(asc(ledgerMappingVersions.version));
      return rows.map(mapMappingVersion);
    },
    async findMappingVersion(id) {
      const [row] = await db.select().from(ledgerMappingVersions).where(eq(ledgerMappingVersions.id, id)).limit(1);
      return row ? mapMappingVersion(row) : null;
    },
    async insertMappings(rows) {
      if (rows.length === 0) {
        return;
      }
      await guard(() => db.insert(ledgerTopicMappings).values(rows));
    },
    async listMappings(mappingVersionId) {
      const rows = await db.select().from(ledgerTopicMappings).where(eq(ledgerTopicMappings.mappingVersionId, mappingVersionId));
      return rows.map(mapMapping);
    },
    async insertSnapshot(row) {
      await guard(() =>
        db.insert(ledgerSnapshots).values({
          ...row,
          measuredAt: new Date(row.measuredAt),
          createdAt: new Date(row.createdAt),
        }),
      );
    },
    async findSnapshot(id) {
      const [row] = await db.select().from(ledgerSnapshots).where(eq(ledgerSnapshots.id, id)).limit(1);
      return row ? mapSnapshot(row) : null;
    },
    async listSnapshots(filter) {
      const conditions = [];
      if (filter.departmentId) {
        conditions.push(eq(ledgerSnapshots.departmentId, filter.departmentId));
      }
      if (filter.topicId) {
        conditions.push(eq(ledgerSnapshots.topicId, filter.topicId));
      }
      const rows = await db
        .select()
        .from(ledgerSnapshots)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(ledgerSnapshots.measuredAt), asc(ledgerSnapshots.id));
      return rows.map(mapSnapshot);
    },
    async insertRetention(row) {
      await guard(() => db.insert(ledgerRetentionEvents).values({ ...row, createdAt: new Date(row.createdAt) }));
    },
    async listRetention(snapshotId) {
      const rows = await db.select().from(ledgerRetentionEvents).where(eq(ledgerRetentionEvents.snapshotId, snapshotId)).orderBy(asc(ledgerRetentionEvents.createdAt));
      return rows.map(mapRetention);
    },
  };
}

function mapTopic(row: typeof ledgerTopics.$inferSelect): LedgerTopic {
  return { id: row.id, departmentId: row.departmentId, createdBy: row.createdBy, createdAt: iso(row.createdAt), provenance: row.provenance };
}

function mapEvent(row: typeof ledgerTopicEvents.$inferSelect): LedgerTopicEvent {
  const eventType = row.eventType === "rename" || row.eventType === "describe" || row.eventType === "deprecate" ? row.eventType : "describe";
  return { id: row.id, topicId: row.topicId, eventType, name: row.name, description: row.description, createdBy: row.createdBy, createdAt: iso(row.createdAt) };
}

function mapProposal(row: typeof ledgerProposals.$inferSelect): LedgerProposal {
  return {
    id: row.id,
    departmentId: row.departmentId,
    kind: row.kind === "mapping" ? "mapping" : "taxonomy",
    payload: row.payload,
    proposedBy: row.proposedBy,
    createdAt: iso(row.createdAt),
  };
}

function mapDecision(row: typeof ledgerDecisions.$inferSelect): LedgerDecision {
  return { id: row.id, proposalId: row.proposalId, decision: row.decision === "rejected" ? "rejected" : "approved", decidedBy: row.decidedBy, createdAt: iso(row.createdAt) };
}

function mapVersion(row: typeof ledgerTaxonomyVersions.$inferSelect): LedgerTaxonomyVersion {
  return { id: row.id, departmentId: row.departmentId, version: row.version, proposalId: row.proposalId, createdBy: row.createdBy, createdAt: iso(row.createdAt) };
}

function mapEdge(row: typeof ledgerTaxonomyEdges.$inferSelect): LedgerEdge {
  return {
    id: row.id,
    versionId: row.versionId,
    topicId: row.topicId,
    parentTopicId: row.parentTopicId,
    kind: row.kind === "cross_link" ? "cross_link" : "parent",
    name: row.name,
    description: row.description,
    status: row.status === "deprecated" ? "deprecated" : "active",
    targetDepartmentId: row.targetDepartmentId,
  };
}

function mapMappingVersion(row: typeof ledgerMappingVersions.$inferSelect): LedgerMappingVersion {
  return {
    id: row.id,
    departmentId: row.departmentId,
    version: row.version,
    taxonomyVersionId: row.taxonomyVersionId,
    proposalId: row.proposalId,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

function mapMapping(row: typeof ledgerTopicMappings.$inferSelect): LedgerMapping {
  return {
    id: row.id,
    mappingVersionId: row.mappingVersionId,
    itemId: row.itemId,
    contentDigest: row.contentDigest,
    topicId: row.topicId,
    weight: row.weight,
    provenance: row.provenance,
  };
}

function mapSnapshot(row: typeof ledgerSnapshots.$inferSelect): LedgerSnapshot {
  return {
    id: row.id,
    departmentId: row.departmentId,
    topicId: row.topicId,
    taxonomyVersionId: row.taxonomyVersionId,
    mappingVersionId: row.mappingVersionId,
    evaluationRunId: row.evaluationRunId,
    evidenceRef: row.evidenceRef,
    manifestFingerprint: row.manifestFingerprint,
    manifest: row.manifest as LedgerSnapshot["manifest"],
    modelFamily: row.modelFamily,
    modelIdentifier: row.modelIdentifier,
    checkpointDigest: row.checkpointDigest,
    adapterId: row.adapterId,
    adapterDigest: row.adapterDigest,
    measuredAt: iso(row.measuredAt),
    validity: row.validity === "invalid" || row.validity === "incomplete" ? row.validity : "valid",
    sampleSize: row.sampleSize,
    correctCount: row.correctCount,
    incorrectCount: row.incorrectCount,
    failureClasses: row.failureClasses,
    accuracy: row.accuracy,
    uncertaintyLow: row.uncertaintyLow,
    uncertaintyHigh: row.uncertaintyHigh,
    measurementMode: row.measurementMode === "retrieval_assisted" ? "retrieval_assisted" : "closed_book",
    capabilityKind: row.capabilityKind === "agent_system" ? "agent_system" : "model",
    items: row.items as LedgerSnapshot["items"],
    provenance: row.provenance,
    schemaVersion: "m9-capability-snapshot-v1",
    certifiedBy: row.certifiedBy,
    createdAt: iso(row.createdAt),
  };
}

function mapRetention(row: typeof ledgerRetentionEvents.$inferSelect): LedgerRetentionEvent {
  const action = row.action === "revoke" || row.action === "archive" ? row.action : "retain";
  return { id: row.id, snapshotId: row.snapshotId, action, decidedBy: row.decidedBy, reason: row.reason, createdAt: iso(row.createdAt) };
}
