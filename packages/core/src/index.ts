export { DomainError, notFound } from "./errors/domain-error.js";
export { snapshot, type RequestContext } from "./context.js";
export { buildPage, decodeCursor, encodeCursor, type DecodedCursor } from "./pagination.js";
export {
  assertAgentBudgetWithinDepartment,
  assertDepartmentBudgetCoversAgents,
  assertParameterBudgetMatchesCompute,
  BUDGET_ENFORCEMENT_SCOPE,
  parseParameterBudget,
  parseResourceBudget,
} from "./budgets/budget.js";
export { assertNoHierarchyCycle } from "./departments/hierarchy.js";
export {
  assertDepartmentTransition,
  canTransitionDepartment,
  DEPARTMENT_TRANSITIONS,
  isPermanentDepartmentType,
} from "./departments/transitions.js";
export { DepartmentService } from "./departments/department-service.js";
export {
  AGENT_TRANSITIONS,
  assertAgentTransition,
  canTransitionAgent,
  isTransitionalStatus,
  recoveryStatus,
} from "./agents/lifecycle.js";
export { AgentService } from "./agents/agent-service.js";
export { Authorizer } from "./governance/authorizer.js";
export { ApprovalService, type ApprovalResult } from "./governance/approval-service.js";
export { IdentityService } from "./governance/identity-service.js";
export {
  assertCanAssignRole,
  assertCanCreateAgentWithRole,
  assertCanCreateDepartment,
  assertCanDecideApproval,
  assertNotSelfBudgetChange,
} from "./governance/self-protection.js";
export {
  isRoleName,
  listRoleGrants,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  permissionsForRole,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from "./governance/permissions.js";
export { AuditQueryService } from "./audit/audit-query-service.js";
export { ModelService } from "./models/model-service.js";
export { AgentRuntime } from "./runtime/agent-runtime.js";
export { LifecycleOnlyExecutor } from "./runtime/lifecycle-only-executor.js";
export { assembleAgentStatus, type AgentExecutor, type RuntimeSession } from "./runtime/status.js";
export { isStaleRuntime } from "./runtime/stale.js";
export type { InferenceWorkerPort, TrainingWorkerPort } from "./runtime/worker-ports.js";
export {
  assertRecipientAgentEligible,
  assertRecipientDepartmentEligible,
  assertSenderEligible,
  canDecideMessage,
  canReadMessage,
  crossDepartmentDeliveryAllowed,
} from "./messaging/access.js";
export { messageIdentityHash } from "./messaging/hash.js";
export { MessageHandlingError, recordReceipt, type MessageHandler } from "./messaging/handlers.js";
export { MessagingService, type DeliveryOutcome, type SendResult } from "./messaging/message-service.js";
export {
  DEAD_EXCHANGE,
  DEAD_QUEUE,
  DEFAULT_MESSAGING_POLICY,
  departmentQueueName,
  MESSAGES_EXCHANGE,
  retryDelayMs,
  routingKeyFor,
  type MessagingPolicy,
} from "./messaging/policy.js";
export type {
  AgentBudgetRow,
  AgentListFilter,
  AgentPatch,
  AgentRepository,
  ApprovalListFilter,
  ApprovalRepository,
  AuditListFilter,
  AuditRepository,
  DepartmentListFilter,
  DepartmentPatch,
  DepartmentRepository,
  LifecycleRepository,
  MessageListFilter,
  MessageRepository,
  MessageVisibility,
  ModelListFilter,
  ModelRepository,
  NewAgent,
  NewApproval,
  NewAuditEvent,
  NewDepartment,
  NewLifecycleEvent,
  NewMessageRecord,
  NewModel,
  NewPrincipal,
  OutboxRow,
  Page,
  PageQuery,
  ProcessingRow,
  ProcessingStatus,
  Persistence,
  PrincipalRecord,
  PrincipalRepository,
  StoredMessage,
  Repositories,
} from "./ports/repositories.js";
