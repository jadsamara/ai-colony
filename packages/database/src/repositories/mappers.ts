import {
  agentSchema,
  approvalSchema,
  auditEventSchema,
  departmentSchema,
  lifecycleEventSchema,
  modelSchema,
  roleNameSchema,
} from "@ai-colony/contracts";
import { permissionsForRole } from "@ai-colony/core";
import type {
  Agent,
  Approval,
  AuditEvent,
  Department,
  LifecycleEvent,
  ModelRecord,
  ParameterBudget,
  PrincipalType,
  ResourceBudget,
  RoleName,
} from "@ai-colony/contracts";
import type { PrincipalRecord } from "@ai-colony/core";
import type {
  agentLifecycleEvents,
  agents,
  approvalRequests,
  auditEvents,
  departments,
  models,
  principals,
} from "../schema/index.js";

type DepartmentRow = typeof departments.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type PrincipalRow = typeof principals.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type ApprovalRow = typeof approvalRequests.$inferSelect;
type AuditRow = typeof auditEvents.$inferSelect;
type LifecycleRow = typeof agentLifecycleEvents.$inferSelect;

export function mapDepartment(row: DepartmentRow): Department {
  return departmentSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    purpose: row.purpose,
    parentDepartmentId: row.parentDepartmentId,
    status: row.status,
    departmentType: row.departmentType,
    creationSource: row.creationSource,
    createdBy: row.createdBy,
    resourceBudget: row.resourceBudget,
    policyRef: row.policyRef,
    metadata: row.metadata,
    specificationVersion: row.specificationVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function mapAgent(row: AgentRow, principal: PrincipalRow): Agent {
  const role = roleNameSchema.parse(row.roleName);
  return agentSchema.parse({
    id: row.id,
    departmentId: row.departmentId,
    name: row.name,
    role,
    description: row.description,
    capabilities: row.capabilities,
    modelId: row.modelId,
    adapterVersion: row.adapterVersion,
    memoryNamespace: row.memoryNamespace,
    permissions: permissionsForRole(role),
    computeBudget: row.computeBudget,
    parameterBudget: row.parameterBudget,
    status: row.status,
    performanceMetrics: row.performanceMetrics,
    parentAgentId: row.parentAgentId,
    principalId: principal.id,
    specificationVersion: row.specificationVersion,
    runtimeOwner: row.runtimeOwner,
    runtimeHeartbeatAt: row.runtimeHeartbeatAt ? row.runtimeHeartbeatAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function mapPrincipal(row: PrincipalRow): PrincipalRecord {
  return {
    id: row.id,
    principalType: row.principalType as PrincipalType,
    displayName: row.displayName,
    role: roleNameSchema.parse(row.roleName) as RoleName,
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapModel(row: ModelRow): ModelRecord {
  return modelSchema.parse({
    id: row.id,
    lineageId: row.lineageId,
    version: row.version,
    displayName: row.displayName,
    modelFamily: row.modelFamily,
    provider: row.provider,
    parameterCount: row.parameterCount,
    modelType: row.modelType,
    artifactUri: row.artifactUri,
    deploymentTarget: row.deploymentTarget,
    status: row.status,
    quantization: row.quantization,
    contextWindow: row.contextWindow,
    capabilities: row.capabilities,
    trainable: row.trainable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function mapApproval(row: ApprovalRow): Approval {
  return approvalSchema.parse({
    id: row.id,
    approvalType: row.approvalType,
    targetType: row.targetType,
    targetId: row.targetId,
    payload: row.payload,
    status: row.status,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
  });
}

export function mapAudit(row: AuditRow): AuditEvent {
  return auditEventSchema.parse({
    eventId: row.eventId,
    eventType: row.eventType,
    actorId: row.actorId,
    actorType: row.actorType,
    targetType: row.targetType,
    targetId: row.targetId,
    action: row.action,
    timestamp: row.occurredAt.toISOString(),
    correlationId: row.correlationId,
    beforeState: row.beforeState,
    afterState: row.afterState,
    metadata: row.metadata,
  });
}

export function mapLifecycle(row: LifecycleRow): LifecycleEvent {
  return lifecycleEventSchema.parse({
    id: row.id,
    agentId: row.agentId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason,
    actorId: row.actorId,
    actorType: row.actorType,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  });
}

export function mapBudgetRow(row: {
  id: string;
  computeBudget: ResourceBudget;
  parameterBudget: ParameterBudget;
}): { id: string; computeBudget: ResourceBudget; parameterBudget: ParameterBudget } {
  return {
    id: row.id,
    computeBudget: row.computeBudget,
    parameterBudget: row.parameterBudget,
  };
}
