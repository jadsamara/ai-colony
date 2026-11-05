import type { EvaluationManifest } from "../evaluation/manifest.js";

export const SNAPSHOT_SCHEMA_VERSION = "m9-capability-snapshot-v1" as const;

export type TopicStatus = "active" | "deprecated";
export type EdgeKind = "parent" | "cross_link";
export type ProposalKind = "taxonomy" | "mapping" | "measurement";
export type ProposalDecision = "approved" | "rejected";
export type MeasurementMode = "closed_book" | "retrieval_assisted";
export type CapabilityKind = "model" | "agent_system";
export type SnapshotValidity = "valid" | "invalid" | "incomplete";
export type RetentionAction = "retain" | "revoke" | "archive";

export interface LedgerTopic {
  id: string;
  departmentId: string;
  createdBy: string;
  createdAt: string;
  provenance: string;
}

export interface LedgerTopicEvent {
  id: string;
  topicId: string;
  eventType: "rename" | "describe" | "deprecate";
  name: string | null;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export interface TaxonomyNodeInput {
  topicId: string;
  parentTopicId: string | null;
  name: string;
  description: string | null;
  status: TopicStatus;
  crossLinks: string[];
}

export interface LedgerProposal {
  id: string;
  departmentId: string;
  kind: ProposalKind;
  payload: unknown;
  proposedBy: string;
  createdAt: string;
}

export interface LedgerDecision {
  id: string;
  proposalId: string;
  decision: ProposalDecision;
  decidedBy: string;
  createdAt: string;
}

export interface LedgerTaxonomyVersion {
  id: string;
  departmentId: string;
  version: number;
  proposalId: string;
  createdBy: string;
  createdAt: string;
}

export interface LedgerEdge {
  id: string;
  versionId: string;
  topicId: string;
  parentTopicId: string | null;
  kind: EdgeKind;
  name: string;
  description: string | null;
  status: TopicStatus;
  targetDepartmentId: string | null;
}

export interface TaxonomyNode {
  topicId: string;
  parentTopicId: string | null;
  name: string;
  description: string | null;
  status: TopicStatus;
  crossLinks: Array<{ topicId: string; departmentId: string | null; grantsMemoryAccess: false }>;
}

export interface MappingItemInput {
  itemId: string;
  contentDigest: string;
  topicId: string;
  weight: number | null;
  provenance: string;
}

export interface LedgerMappingVersion {
  id: string;
  departmentId: string;
  version: number;
  taxonomyVersionId: string;
  proposalId: string;
  createdBy: string;
  createdAt: string;
}

export interface LedgerMapping {
  id: string;
  mappingVersionId: string;
  itemId: string;
  contentDigest: string;
  topicId: string;
  weight: number | null;
  provenance: string;
}

export interface SnapshotItem {
  itemId: string;
  contentDigest: string;
  correct: boolean | null;
  valid: boolean;
}

export interface LedgerSnapshot {
  id: string;
  departmentId: string;
  topicId: string;
  taxonomyVersionId: string;
  mappingVersionId: string;
  evaluationRunId: string | null;
  evidenceRef: string;
  manifestFingerprint: string;
  manifest: EvaluationManifest;
  modelFamily: string | null;
  modelIdentifier: string | null;
  checkpointDigest: string | null;
  adapterId: string | null;
  adapterDigest: string | null;
  measuredAt: string;
  validity: SnapshotValidity;
  sampleSize: number;
  correctCount: number;
  incorrectCount: number;
  failureClasses: Record<string, number>;
  accuracy: number;
  uncertaintyLow: number;
  uncertaintyHigh: number;
  measurementMode: MeasurementMode;
  capabilityKind: CapabilityKind;
  items: SnapshotItem[];
  provenance: string;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  certifiedBy: string;
  createdAt: string;
}

export interface LedgerRetentionEvent {
  id: string;
  snapshotId: string;
  action: RetentionAction;
  decidedBy: string;
  reason: string;
  createdAt: string;
}

export interface ModelIdentitySeparation {
  measuredCapability: {
    checkpointDigest: string | null;
    adapterDigest: string | null;
    modelFamily: string | null;
    modelIdentifier: string | null;
  };
  assignedModel: null;
  servingModel: null;
  historicalModelIdentity: {
    checkpointDigest: string | null;
    adapterDigest: string | null;
  };
}
