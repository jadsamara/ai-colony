import { DEDICATED_SERVING_POLICY_VERSION } from "../serving/types.js";
import { isLegacyDepartment, LEGACY_ROUTING_POLICY_VERSION, ROUTING_EVIDENCE_TTL_MS, SHARED_QWEN3_8B_MODEL_ID } from "./policy.js";
import type { RoutingAssignment, RoutingReasonCode, RoutingSelection, RoutingSnapshot, RuntimeReadiness } from "./types.js";

export function evaluateRouting(snapshot: RoutingSnapshot): RoutingSelection {
  return applyDedicatedServing(snapshot, evaluateModelRouting(snapshot));
}

function evaluateModelRouting(snapshot: RoutingSnapshot): RoutingSelection {
  const latest = [...snapshot.assignments].sort((left, right) => right.version - left.version)[0] ?? null;
  const active = latest?.status === "active" ? latest : null;
  const base = blank(snapshot, active);
  if (snapshot.departmentStatus !== "active") {
    return deny(base, "department_inactive");
  }
  if (snapshot.agentDepartmentId && snapshot.agentDepartmentId !== snapshot.departmentId) {
    return deny(base, "department_identity_mismatch");
  }
  if (snapshot.servingBackend !== "ollama") {
    return deny(base, "unsupported_backend");
  }
  if (!snapshot.budgetAllowed) {
    return deny(base, "budget_denied");
  }
  if (!snapshot.resourceAllowed) {
    return deny(base, "resource_denied");
  }
  const readiness = effectiveReadiness(snapshot);
  base.runtimeState = readiness;
  if (latest?.status === "rejected") {
    return deny(base, "disabled_assignment");
  }
  if (active?.role === "fallback") {
    return deny({ ...base, assignmentId: active.id, assignmentVersion: active.version }, "fallback_disabled");
  }
  if (active?.role === "experimental_adapter") {
    return deny({ ...base, assignmentId: active.id, assignmentVersion: active.version }, "unapproved_assignment");
  }

  const selected = select(snapshot, active);
  if (!selected.ok) {
    return deny({ ...base, assignmentId: active?.id ?? null, assignmentVersion: active?.version ?? null }, selected.reasonCode);
  }
  const { ok: _ignored, ...chosen } = selected;
  if (snapshot.requestedModelId && snapshot.requestedModelId !== chosen.registryModelId) {
    return deny({ ...base, ...chosen }, "model_override_denied");
  }
  if (readiness === "runtime_unreachable") {
    return deny({ ...base, ...chosen }, "runtime_unavailable");
  }
  if (readiness === "evidence_stale") {
    return deny({ ...base, ...chosen }, "stale_runtime_evidence");
  }
  if (snapshot.executionDigest && chosen.modelDigest && snapshot.executionDigest !== chosen.modelDigest) {
    return deny({ ...base, ...chosen, executionVerification: "mismatch" }, "digest_mismatch");
  }
  const verification = snapshot.executionDigest && chosen.modelDigest && snapshot.executionDigest === chosen.modelDigest
    ? "matched"
    : "unverified";
  return {
    ...base,
    ...chosen,
    authorization: "authorized",
    executionVerification: verification,
    reasonCode: chosen.reasonCode,
  };
}

function select(
  snapshot: RoutingSnapshot,
  active: RoutingAssignment | null,
): { ok: true } & Pick<RoutingSelection, "reasonCode" | "assignmentId" | "assignmentVersion" | "registryModelId" | "servingModel" | "modelDigest" | "adapterId" | "adapterVersion"> | { ok: false; reasonCode: RoutingReasonCode } {
  if (active?.role === "capability_adapter") {
    if (!snapshot.derived) {
      return { ok: false, reasonCode: "missing_derived_model" };
    }
    const adapterMatches = active.adapterSha256 === null || snapshot.derived.adapterId === active.adapterSha256;
    if (!snapshot.derived.provenanceVerified || snapshot.derived.baseRegistryModelId !== active.registryModelId || !adapterMatches) {
      return { ok: false, reasonCode: "invalid_adapter_provenance" };
    }
    return {
      ok: true,
      reasonCode: "authorized_assignment",
      assignmentId: active.id,
      assignmentVersion: active.version,
      registryModelId: active.registryModelId,
      servingModel: snapshot.derived.servingModel,
      modelDigest: snapshot.derived.digest,
      adapterId: snapshot.derived.adapterId,
      adapterVersion: snapshot.derived.adapterVersion,
    };
  }
  if (active?.role === "shared_base") {
    const model = snapshot.models[active.registryModelId];
    if (!model || model.modelFamily !== active.modelFamily) {
      return { ok: false, reasonCode: "invalid_assignment" };
    }
    if (model.id !== SHARED_QWEN3_8B_MODEL_ID && model.status !== "available") {
      return { ok: false, reasonCode: "deployment_not_authorized" };
    }
    const servingModel = model.id === SHARED_QWEN3_8B_MODEL_ID
      ? snapshot.sharedServingTag
      : snapshot.evidence.servingTag;
    if (!servingModel || (model.id !== SHARED_QWEN3_8B_MODEL_ID && servingModel === snapshot.sharedServingTag)) {
      return { ok: false, reasonCode: "invalid_assignment" };
    }
    return {
      ok: true,
      reasonCode: "authorized_assignment",
      assignmentId: active.id,
      assignmentVersion: active.version,
      registryModelId: model.id,
      servingModel,
      modelDigest: snapshot.evidence.servingTag === null || snapshot.evidence.servingTag === servingModel ? snapshot.evidence.digest : null,
      adapterId: null,
      adapterVersion: null,
    };
  }
  if (!isLegacyDepartment(snapshot.departmentId)) {
    return { ok: false, reasonCode: "missing_assignment" };
  }
  const shared = snapshot.models[SHARED_QWEN3_8B_MODEL_ID];
  if (!shared) {
    return { ok: false, reasonCode: "invalid_assignment" };
  }
  return {
    ok: true,
    reasonCode: "authorized_legacy_default",
    assignmentId: null,
    assignmentVersion: null,
    registryModelId: SHARED_QWEN3_8B_MODEL_ID,
    servingModel: snapshot.sharedServingTag,
    modelDigest: snapshot.evidence.servingTag === null || snapshot.evidence.servingTag === snapshot.sharedServingTag ? snapshot.evidence.digest : null,
    adapterId: null,
    adapterVersion: null,
  };
}

function effectiveReadiness(snapshot: RoutingSnapshot): RuntimeReadiness {
  if (snapshot.evidence.state === "readiness_unknown") {
    return "readiness_unknown";
  }
  if (snapshot.evidence.state === "runtime_unreachable") {
    return "runtime_unreachable";
  }
  if (!snapshot.evidence.capturedAt) {
    return "evidence_stale";
  }
  const age = Date.parse(snapshot.now) - Date.parse(snapshot.evidence.capturedAt);
  if (!Number.isFinite(age) || age > ROUTING_EVIDENCE_TTL_MS) {
    return "evidence_stale";
  }
  return snapshot.evidence.state;
}

function blank(snapshot: RoutingSnapshot, active: RoutingAssignment | null): RoutingSelection {
  return {
    authorization: "denied",
    reasonCode: "missing_assignment",
    departmentId: snapshot.departmentId,
    assignmentId: active?.id ?? null,
    assignmentVersion: active?.version ?? null,
    registryModelId: SHARED_QWEN3_8B_MODEL_ID,
    servingModel: snapshot.sharedServingTag,
    modelDigest: snapshot.evidence.digest,
    adapterId: null,
    adapterVersion: null,
    policyVersion: LEGACY_ROUTING_POLICY_VERSION,
    fallbackStatus: "disabled",
    budgetOutcome: snapshot.budgetAllowed ? "allowed" : "denied",
    resourceOutcome: !snapshot.resourceAllowed ? "denied" : snapshot.memoryKnown ? "allowed" : "memory_unknown",
    executionVerification: "unverified",
    capabilityNote: capabilityNote(snapshot),
    runtimeState: snapshot.evidence.state,
    evidenceCapturedAt: snapshot.evidence.capturedAt,
    servingInstanceId: null,
    endpointReference: null,
    agentId: null,
    servingPolicyVersion: null,
  };
}

function applyDedicatedServing(snapshot: RoutingSnapshot, decision: RoutingSelection): RoutingSelection {
  if (!snapshot.dedicated) {
    return decision;
  }
  const dedicated = snapshot.dedicated;
  const mine = dedicated.instances.filter((instance) => instance.departmentId === snapshot.departmentId);
  const instance = mine.length === 1 ? mine[0] : null;
  const stamped: RoutingSelection = {
    ...decision,
    servingInstanceId: instance?.instanceId ?? null,
    endpointReference: instance?.endpointReference ?? null,
    agentId: instance?.agentId ?? null,
    servingPolicyVersion: DEDICATED_SERVING_POLICY_VERSION,
  };
  if (!instance) {
    return deny(stamped, "serving_instance_unassigned");
  }
  const owners = new Map<string, string>();
  for (const candidate of dedicated.instances) {
    const previous = owners.get(candidate.normalizedEndpoint);
    if (previous && previous !== candidate.departmentId) {
      return deny(stamped, "serving_endpoint_shared");
    }
    owners.set(candidate.normalizedEndpoint, candidate.departmentId);
  }
  if (
    (dedicated.requestedEndpoint && dedicated.requestedEndpoint !== instance.endpointReference) ||
    (dedicated.requestedInstanceId && dedicated.requestedInstanceId !== instance.instanceId)
  ) {
    return deny(stamped, "endpoint_override_denied");
  }
  if (
    (dedicated.pinnedInstanceId && dedicated.pinnedInstanceId !== instance.instanceId) ||
    (dedicated.pinnedModelVersion && dedicated.pinnedModelVersion !== instance.modelVersion)
  ) {
    return deny(stamped, "serving_migration_required");
  }
  if (instance.status !== "ready" || instance.deploymentMode !== "dedicated") {
    return deny(stamped, "serving_instance_unavailable");
  }
  return stamped;
}

function deny(selection: RoutingSelection, reasonCode: RoutingReasonCode): RoutingSelection {
  return { ...selection, authorization: "denied", reasonCode };
}

function capabilityNote(snapshot: RoutingSnapshot): string {
  if (snapshot.syntheticCapabilityCount > 0 && snapshot.certifiedCapabilityCount === 0) {
    return "Synthetic capability evidence is excluded and does not authorize a model.";
  }
  if (snapshot.certifiedCapabilityCount === 0) {
    return "No certified capability evidence. That is not zero capability and does not authorize deployment.";
  }
  return `${snapshot.certifiedCapabilityCount} certified snapshots were visible and did not change deployment authorization.`;
}

export function inferencePathClass(path: string): "operational" | "evaluation" | "training" | "health" | "exempt" {
  if (path.includes("workflows/src/runtime.ts") || path.includes("objectives/objective-service.ts")) {
    return "operational";
  }
  if (path.includes("evaluation/")) {
    return "evaluation";
  }
  if (path.includes("training/") || path.includes("services/training") || path.includes("research/")) {
    return "training";
  }
  if (path.includes("ollama-status.ts") || path.includes("runtime-health") || path.includes("colony-health")) {
    return "health";
  }
  return "exempt";
}
