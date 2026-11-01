import type { DeploymentEligibility, ImprovementClass } from "../evaluation/improvement.js";
import type { LearningCycleStatus, LearningMechanism, OutcomeKind } from "./transitions.js";

export interface CapabilityRecord {
  id: string;
  departmentId: string;
  slug: string;
  domain: string;
  taskType: string;
  description: string;
  createdBy: string;
  createdAt: string;
}

export interface CapabilityVersionRecord {
  id: string;
  capabilityId: string;
  version: number;
  status: "proposed" | "experimental" | "evaluated" | "approved" | "rejected" | "revoked" | "superseded";
  toolNames: string[];
  requiredPermissions: string[];
  evidence: Record<string, unknown>;
  evaluationRunId: string | null;
  benchmarkVersionId: string | null;
  reliability: Record<string, unknown>;
  resources: Record<string, unknown>;
  improvementKind: OutcomeKind;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
}

export interface GapRecord {
  id: string;
  departmentId: string;
  capabilityId: string | null;
  taskCategory: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
  failureCount: number;
  severity: "low" | "medium" | "high";
  impact: string;
  baseline: Record<string, unknown>;
  proposedMethod: LearningMechanism;
  resources: Record<string, unknown>;
  status: "observed" | "validated" | "rejected" | "aggregated";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningObjectiveRecord {
  id: string;
  departmentId: string;
  gapId: string;
  capabilityId: string | null;
  version: number;
  weakness: string;
  mechanism: LearningMechanism;
  criteria: Record<string, unknown>;
  benchmarkVersionId: string | null;
  baselineRef: string | null;
  budget: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface LearningCycleRecord {
  id: string;
  objectiveId: string | null;
  departmentId: string;
  status: LearningCycleStatus;
  method: LearningMechanism;
  outcomeKind: OutcomeKind | null;
  trainingRunId: string | null;
  evaluationRunId: string | null;
  gateDecision: string | null;
  transferId: string | null;
  memoryId: string | null;
  idempotencyKey: string;
  correlationId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningEventRecord {
  id: string;
  cycleId: string;
  fromStatus: string;
  toStatus: string;
  actorId: string;
  reason: string;
  createdAt: string;
}

export interface AssignmentRecord {
  id: string;
  departmentId: string;
  role: "shared_base" | "experimental_adapter" | "capability_adapter" | "fallback";
  registryModelId: string;
  trainableModelId: string | null;
  candidateId: string | null;
  adapterSha256: string | null;
  modelFamily: string;
  version: number;
  status: "active" | "superseded" | "rejected";
  createdBy: string;
  createdAt: string;
}

export interface TransferRecord {
  id: string;
  originDepartmentId: string;
  destinationDepartmentId: string;
  sourceMemoryId: string | null;
  summary: string;
  provenance: string;
  trust: string;
  evidence: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected";
  version: number;
  restrictions: string;
  idempotencyKey: string;
  cycleId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ValidationRecord {
  id: string;
  transferId: string;
  decision: "accept" | "reject";
  decidedBy: string;
  reason: string;
  acceptedMemoryId: string | null;
  createdAt: string;
}

export interface OutcomeRecord {
  id: string;
  cycleId: string;
  kind: OutcomeKind;
  verified: boolean;
  summary: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface BudgetRecord {
  id: string;
  cycleId: string;
  maxInferenceCalls: number;
  maxTrainingSteps: number;
  maxRuntimeMs: number;
  usedInferenceCalls: number;
  usedTrainingSteps: number;
  usedRuntimeMs: number;
}

export interface ImprovementDecisionRecord {
  id: string;
  evaluationRunId: string | null;
  cycleId: string | null;
  policyVersion: string;
  policyHash: string;
  safetyGate: string;
  safetyGateVersion: string;
  classification: ImprovementClass;
  deploymentEligibility: DeploymentEligibility;
  baselineRef: string | null;
  candidateId: string | null;
  sampleCount: number;
  effectSize: number;
  uncertainty: Record<string, unknown>;
  retention: Record<string, unknown>;
  evidence: Record<string, unknown>;
  rationale: string;
  decidedBy: string;
  createdAt: string;
}

export interface DeploymentDecisionRecord {
  id: string;
  cycleId: string;
  improvementDecisionId: string | null;
  purpose: "improvement" | "exceptional";
  eligibility: DeploymentEligibility;
  adopted: boolean;
  rationale: string;
  decidedBy: string;
  createdAt: string;
}

export interface CollaborationContextRecord {
  id: string;
  classification: "consultation" | "specialist" | "joint";
  ownerDepartmentId: string;
  status: "open" | "closed" | "expired";
  purpose: string;
  expiresAt: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
}

export interface CollaborationParticipantRecord {
  id: string;
  contextId: string;
  departmentId: string;
  role: "owner" | "contributor";
  status: "invited" | "active" | "removed";
  createdAt: string;
}

export interface CollaborationEntryRecord {
  id: string;
  contextId: string;
  authorDepartmentId: string;
  kind: "request_context" | "answer" | "contribution" | "shared_decision";
  content: string;
  provenance: "model_generated" | "system_observed" | "user_provided" | "externally_verified";
  status: "active" | "expired" | "archived" | "promoted";
  expiresAt: string | null;
  promotedMemoryId: string | null;
  sourceMemoryId: string | null;
  idempotencyKey: string;
  createdAt: string;
}

export interface MemoryOwnershipRecord {
  memoryId: string;
  originatingDepartmentId: string | null;
  primaryOwnerDepartmentId: string;
  recipientDepartmentId: string | null;
  classification: CollaborationContextRecord["classification"];
  collaborationId: string | null;
  retentionPolicy: string;
  promotionReason: string;
  validationStatus: "validated" | "unverified";
  sourceMessageId: string | null;
  createdAt: string;
}

export interface LearningRepository {
  insertCapability(row: CapabilityRecord): Promise<void>;
  findCapability(id: string): Promise<CapabilityRecord | null>;
  findCapabilityBySlug(departmentId: string, slug: string): Promise<CapabilityRecord | null>;
  listCapabilities(departmentId?: string): Promise<CapabilityRecord[]>;
  insertCapabilityVersion(row: CapabilityVersionRecord): Promise<void>;
  listCapabilityVersions(capabilityId: string): Promise<CapabilityVersionRecord[]>;
  insertGap(row: GapRecord): Promise<void>;
  findGap(id: string): Promise<GapRecord | null>;
  findGapByFingerprint(departmentId: string, fingerprint: string): Promise<GapRecord | null>;
  updateGap(id: string, patch: Partial<Pick<GapRecord, "failureCount" | "status" | "updatedAt" | "evidence">>): Promise<void>;
  listGaps(departmentId?: string): Promise<GapRecord[]>;
  insertObjective(row: LearningObjectiveRecord): Promise<void>;
  findObjective(id: string): Promise<LearningObjectiveRecord | null>;
  listObjectives(departmentId?: string): Promise<LearningObjectiveRecord[]>;
  insertCycle(row: LearningCycleRecord): Promise<void>;
  findCycle(id: string): Promise<LearningCycleRecord | null>;
  findCycleByKey(key: string): Promise<LearningCycleRecord | null>;
  updateCycle(id: string, patch: Partial<LearningCycleRecord>): Promise<void>;
  listCycles(departmentId?: string): Promise<LearningCycleRecord[]>;
  countExecutingLora(exceptId?: string): Promise<number>;
  insertEvent(row: LearningEventRecord): Promise<void>;
  listEvents(cycleId: string): Promise<LearningEventRecord[]>;
  insertAssignment(row: AssignmentRecord): Promise<void>;
  listAssignments(departmentId: string): Promise<AssignmentRecord[]>;
  supersedeAssignments(departmentId: string): Promise<void>;
  insertTransfer(row: TransferRecord): Promise<void>;
  findTransfer(id: string): Promise<TransferRecord | null>;
  findTransferByKey(key: string): Promise<TransferRecord | null>;
  updateTransfer(id: string, patch: Partial<Pick<TransferRecord, "status" | "cycleId">>): Promise<void>;
  listTransfers(): Promise<TransferRecord[]>;
  insertValidation(row: ValidationRecord): Promise<void>;
  findValidation(transferId: string): Promise<ValidationRecord | null>;
  insertOutcome(row: OutcomeRecord): Promise<void>;
  findOutcome(cycleId: string): Promise<OutcomeRecord | null>;
  insertBudget(row: BudgetRecord): Promise<void>;
  findBudget(cycleId: string): Promise<BudgetRecord | null>;
  updateBudget(cycleId: string, patch: Partial<Pick<BudgetRecord, "maxInferenceCalls" | "maxTrainingSteps" | "maxRuntimeMs" | "usedInferenceCalls" | "usedTrainingSteps" | "usedRuntimeMs">>): Promise<void>;
  insertImprovement(row: ImprovementDecisionRecord): Promise<void>;
  findImprovement(evaluationRunId: string, policyVersion: string): Promise<ImprovementDecisionRecord | null>;
  listImprovements(cycleId: string): Promise<ImprovementDecisionRecord[]>;
  insertDeployment(row: DeploymentDecisionRecord): Promise<void>;
  findDeployment(cycleId: string, purpose: "improvement" | "exceptional"): Promise<DeploymentDecisionRecord | null>;
  insertContext(row: CollaborationContextRecord): Promise<void>;
  findContext(id: string): Promise<CollaborationContextRecord | null>;
  findContextByKey(key: string): Promise<CollaborationContextRecord | null>;
  updateContext(id: string, patch: Partial<Pick<CollaborationContextRecord, "status" | "closedAt">>): Promise<void>;
  insertParticipant(row: CollaborationParticipantRecord): Promise<void>;
  listParticipants(contextId: string): Promise<CollaborationParticipantRecord[]>;
  updateParticipant(id: string, status: CollaborationParticipantRecord["status"]): Promise<void>;
  insertEntry(row: CollaborationEntryRecord): Promise<void>;
  findEntry(id: string): Promise<CollaborationEntryRecord | null>;
  findEntryByKey(key: string): Promise<CollaborationEntryRecord | null>;
  listEntries(contextId: string): Promise<CollaborationEntryRecord[]>;
  updateEntry(id: string, patch: Partial<Pick<CollaborationEntryRecord, "status" | "promotedMemoryId">>): Promise<void>;
  expireDue(nowIso: string): Promise<{ entries: number; contexts: number }>;
  insertOwnership(row: MemoryOwnershipRecord): Promise<void>;
  findOwnership(memoryId: string): Promise<MemoryOwnershipRecord | null>;
  listOwnership(): Promise<MemoryOwnershipRecord[]>;
}
