import type { DedicatedRoutingContext } from "../serving/types.js";

export type RoutingAuthorization = "authorized" | "denied";

export type RoutingReasonCode =
  | "authorized_legacy_default"
  | "authorized_assignment"
  | "missing_assignment"
  | "disabled_assignment"
  | "invalid_assignment"
  | "unapproved_assignment"
  | "deployment_not_authorized"
  | "runtime_unavailable"
  | "stale_runtime_evidence"
  | "missing_derived_model"
  | "invalid_adapter_provenance"
  | "unsupported_backend"
  | "fallback_disabled"
  | "budget_denied"
  | "resource_denied"
  | "model_override_denied"
  | "digest_mismatch"
  | "department_inactive"
  | "department_identity_mismatch"
  | "serving_instance_unassigned"
  | "serving_instance_unavailable"
  | "serving_endpoint_shared"
  | "endpoint_override_denied"
  | "serving_migration_required";

export type RuntimeReadiness =
  | "registered"
  | "installed"
  | "loaded"
  | "readiness_verified"
  | "readiness_unknown"
  | "runtime_unreachable"
  | "evidence_stale";

export interface RuntimeEvidence {
  state: RuntimeReadiness;
  capturedAt: string | null;
  digest: string | null;
  servingTag: string | null;
  artifactBytes: number | null;
  loadedCount: number | null;
}

export interface DerivedServingArtifact {
  servingModel: string;
  digest: string | null;
  baseRegistryModelId: string;
  adapterId: string;
  adapterVersion: string;
  provenanceVerified: boolean;
}

export interface RoutingAssignment {
  id: string;
  departmentId: string;
  role: "shared_base" | "experimental_adapter" | "capability_adapter" | "fallback";
  registryModelId: string;
  adapterSha256: string | null;
  modelFamily: string;
  version: number;
  status: "active" | "superseded" | "rejected";
}

export interface RoutingModel {
  id: string;
  status: string;
  modelFamily: string;
  displayName: string;
}

export interface RoutingSnapshot {
  departmentId: string;
  departmentStatus: string;
  agentDepartmentId: string | null;
  assignments: readonly RoutingAssignment[];
  models: Readonly<Record<string, RoutingModel>>;
  requestedModelId: string | null;
  sharedServingTag: string;
  derived: DerivedServingArtifact | null;
  evidence: RuntimeEvidence;
  now: string;
  budgetAllowed: boolean;
  resourceAllowed: boolean;
  memoryKnown: boolean;
  servingBackend: "ollama" | "other";
  certifiedCapabilityCount: number;
  syntheticCapabilityCount: number;
  executionDigest: string | null;
  dedicated?: DedicatedRoutingContext;
}

export interface RoutingSelection {
  authorization: RoutingAuthorization;
  reasonCode: RoutingReasonCode;
  departmentId: string;
  assignmentId: string | null;
  assignmentVersion: number | null;
  registryModelId: string;
  servingModel: string;
  modelDigest: string | null;
  adapterId: string | null;
  adapterVersion: string | null;
  policyVersion: string;
  fallbackStatus: "disabled";
  budgetOutcome: "allowed" | "denied";
  resourceOutcome: "allowed" | "denied" | "memory_unknown";
  executionVerification: "unverified" | "matched" | "mismatch";
  capabilityNote: string;
  runtimeState: RuntimeReadiness;
  evidenceCapturedAt: string | null;
  servingInstanceId: string | null;
  endpointReference: string | null;
  agentId: string | null;
  servingPolicyVersion: string | null;
}
