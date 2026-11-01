import type {
  AddressingMode,
  Agent,
  AgentRuntimeView,
  AgentStatus,
  Approval,
  ApprovalStatus,
  ApprovalTargetType,
  ApprovalType,
  AuditEvent,
  DeadLetter,
  Department,
  DepartmentStatus,
  LifecycleEvent,
  Message,
  MessageStatus,
  MessageType,
  MessagingMetrics,
  ModelRecord,
  ModelStatus,
  ObjectiveStatus,
  ParameterBudget,
  PrincipalType,
  ResourceBudget,
  RoleName,
  RuntimeStatus,
  TaskStatus,
  TaskType,
} from "@ai-colony/contracts";
import type { DecodedCursor } from "../pagination.js";

export interface PageQuery {
  limit: number;
  cursor: DecodedCursor | null;
}

export interface DepartmentListFilter extends PageQuery {
  status?: DepartmentStatus;
  departmentType?: Department["departmentType"];
  parentDepartmentId?: string;
}

export interface AgentListFilter extends PageQuery {
  departmentId?: string;
  status?: AgentStatus;
}

export interface ModelListFilter extends PageQuery {
  status?: ModelStatus;
  lineageId?: string;
}

export interface ApprovalListFilter extends PageQuery {
  status?: ApprovalStatus;
  approvalType?: ApprovalType;
  targetId?: string;
}

export interface AuditListFilter extends PageQuery {
  targetType?: string;
  targetId?: string;
  eventType?: string;
}

export interface Page<T> {
  data: T[];
  page: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface NewDepartment {
  id: string;
  name: string;
  slug: string;
  description: string;
  purpose: string;
  parentDepartmentId: string | null;
  status: DepartmentStatus;
  departmentType: Department["departmentType"];
  creationSource: Department["creationSource"];
  createdBy: string;
  resourceBudget: ResourceBudget;
  policyRef: string | null;
  metadata: Record<string, unknown>;
  specificationVersion: Department["specificationVersion"];
}

export interface DepartmentPatch {
  name?: string;
  description?: string;
  purpose?: string;
  parentDepartmentId?: string | null;
  status?: DepartmentStatus;
  resourceBudget?: ResourceBudget;
  policyRef?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NewAgent {
  id: string;
  departmentId: string;
  name: string;
  role: RoleName;
  description: string;
  capabilities: string[];
  modelId: string | null;
  adapterVersion: string | null;
  memoryNamespace: string;
  computeBudget: ResourceBudget;
  parameterBudget: ParameterBudget;
  status: AgentStatus;
  performanceMetrics: Record<string, number>;
  parentAgentId: string | null;
  specificationVersion: Agent["specificationVersion"];
  principalId: string;
  principalType: PrincipalType;
}

export interface AgentPatch {
  name?: string;
  description?: string;
  capabilities?: string[];
  modelId?: string | null;
  adapterVersion?: string | null;
  memoryNamespace?: string;
  performanceMetrics?: Record<string, number>;
  parentAgentId?: string | null;
  role?: RoleName;
  computeBudget?: ResourceBudget;
  parameterBudget?: ParameterBudget;
  status?: AgentStatus;
  runtimeOwner?: string | null;
  runtimeHeartbeatAt?: string | null;
}

export interface AgentBudgetRow {
  id: string;
  computeBudget: ResourceBudget;
  parameterBudget: ParameterBudget;
}

export interface NewPrincipal {
  id: string;
  principalType: PrincipalType;
  displayName: string;
  role: RoleName;
  agentId: string | null;
}

export interface PrincipalRecord {
  id: string;
  principalType: PrincipalType;
  displayName: string;
  role: RoleName;
  agentId: string | null;
  createdAt: string;
}

export interface NewModel {
  id: string;
  lineageId: string;
  version: number;
  displayName: string;
  modelFamily: string;
  provider: string;
  parameterCount: number;
  modelType: string;
  artifactUri: string | null;
  deploymentTarget: ModelRecord["deploymentTarget"];
  status: ModelStatus;
  quantization: ModelRecord["quantization"];
  contextWindow: number | null;
  capabilities: string[];
  trainable: boolean;
}

export interface NewApproval {
  id: string;
  approvalType: ApprovalType;
  targetType: ApprovalTargetType;
  targetId: string;
  payload: Record<string, unknown>;
  requestedBy: string;
}

export interface NewAuditEvent {
  eventType: string;
  actorId: string;
  actorType: string;
  targetType: string;
  targetId: string;
  action: string;
  correlationId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export interface NewLifecycleEvent {
  agentId: string;
  fromStatus: AgentStatus;
  toStatus: AgentStatus;
  reason: string;
  actorId: string;
  actorType: string;
  correlationId: string;
}

export interface DepartmentRepository {
  insert(input: NewDepartment): Promise<Department>;
  update(id: string, patch: DepartmentPatch): Promise<Department>;
  findById(id: string): Promise<Department | null>;
  lockById(id: string): Promise<Department | null>;
  lockAncestorIds(startId: string): Promise<string[]>;
  list(filter: DepartmentListFilter): Promise<Page<Department>>;
  listChildren(parentId: string): Promise<Department[]>;
}

export interface AgentRepository {
  insert(input: NewAgent): Promise<Agent>;
  update(id: string, patch: AgentPatch): Promise<Agent>;
  findById(id: string): Promise<Agent | null>;
  lockById(id: string): Promise<Agent | null>;
  lockAncestorIds(startId: string): Promise<string[]>;
  list(filter: AgentListFilter): Promise<Page<Agent>>;
  listBudgetsByDepartment(departmentId: string): Promise<AgentBudgetRow[]>;
  listStaleRuntimeAgents(cutoff: Date): Promise<Agent[]>;
  touchHeartbeats(agentIds: readonly string[], at: Date): Promise<void>;
}

export interface PrincipalRepository {
  findById(id: string): Promise<PrincipalRecord | null>;
  findByAgentId(agentId: string): Promise<PrincipalRecord | null>;
  insert(input: NewPrincipal): Promise<PrincipalRecord>;
  updateRole(id: string, role: RoleName, displayName?: string): Promise<void>;
}

export interface ModelRepository {
  insert(input: NewModel): Promise<ModelRecord>;
  findById(id: string): Promise<ModelRecord | null>;
  maxVersion(lineageId: string): Promise<number>;
  updateStatus(id: string, status: ModelStatus): Promise<ModelRecord>;
  list(filter: ModelListFilter): Promise<Page<ModelRecord>>;
}

export interface ApprovalRepository {
  insert(input: NewApproval): Promise<Approval>;
  findById(id: string): Promise<Approval | null>;
  lockById(id: string): Promise<Approval | null>;
  list(filter: ApprovalListFilter): Promise<Page<Approval>>;
  decide(
    id: string,
    decision: {
      status: "approved" | "rejected";
      decidedBy: string;
      decisionReason: string;
      consumedAt: string | null;
    },
  ): Promise<Approval>;
}

export interface AuditRepository {
  append(input: NewAuditEvent): Promise<AuditEvent>;
  list(filter: AuditListFilter): Promise<Page<AuditEvent>>;
}

export interface LifecycleRepository {
  append(input: NewLifecycleEvent): Promise<LifecycleEvent>;
  listByAgent(agentId: string, filter: PageQuery): Promise<Page<LifecycleEvent>>;
}

export type OutboxStatus = "pending" | "publishing" | "published" | "failed";
export type ProcessingStatus =
  | "processing"
  | "recorded"
  | "acknowledged"
  | "rejected"
  | "expired"
  | "dead_lettered"
  | "retry_scheduled";

export interface MessageVisibility {
  unrestricted: boolean;
  agentId: string | null;
  departmentId: string | null;
}

export interface MessageListFilter extends PageQuery {
  visibility: MessageVisibility;
  messageType?: MessageType;
  status?: MessageStatus;
  correlationId?: string;
  inbox?: "agent" | "department" | "sent";
}

export interface DeadLetterListFilter extends PageQuery {
  visibility: MessageVisibility;
  status?: "open" | "redriven";
}

export interface NewMessageRecord {
  id: string;
  messageType: MessageType;
  senderAgentId: string;
  senderDepartmentId: string;
  recipientAgentId: string | null;
  recipientDepartmentId: string | null;
  addressingMode: AddressingMode;
  inboxDepartmentId: string;
  correlationId: string;
  causationId: string | null;
  replyToMessageId: string | null;
  priority: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
}

export interface StoredMessage {
  message: Message;
  payloadHash: string;
}

export interface OutboxRow {
  outboxId: string;
  messageId: string;
  attempt: number;
  status: OutboxStatus;
  publishAttempts: number;
  availableAt: string;
  publishedAt: string | null;
  lastError: string | null;
  claimedBy: string | null;
}

export interface ProcessingRow {
  messageId: string;
  status: ProcessingStatus;
  attemptCount: number;
  owner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  completedAt: string | null;
}

export interface MessageRepository {
  insertAccepted(input: NewMessageRecord): Promise<StoredMessage>;
  findById(id: string): Promise<StoredMessage | null>;
  lockById(id: string): Promise<StoredMessage | null>;
  findByIdempotency(senderAgentId: string, key: string): Promise<StoredMessage | null>;
  list(filter: MessageListFilter): Promise<Page<Message>>;
  updateStatus(id: string, status: MessageStatus): Promise<StoredMessage>;
  claimOutbox(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<Array<OutboxRow & { message: Message }>>;
  markPublished(outboxId: string, workerId: string): Promise<void>;
  schedulePublishRetry(input: {
    outboxId: string;
    workerId: string;
    availableAt: Date;
    error: string;
    fail: boolean;
  }): Promise<void>;
  insertOutbox(messageId: string, attempt: number, availableAt: Date): Promise<void>;
  nextOutboxAttempt(messageId: string): Promise<number>;
  listOutbox(messageId: string): Promise<OutboxRow[]>;
  lockProcessing(messageId: string): Promise<ProcessingRow | null>;
  insertProcessing(input: { messageId: string; owner: string; leaseUntil: Date }): Promise<void>;
  touchProcessingLease(messageId: string, workerId: string, leaseUntil: Date): Promise<boolean>;
  updateProcessing(
    messageId: string,
    patch: {
      status: ProcessingStatus;
      attemptCount?: number;
      owner?: string | null;
      leaseUntil?: Date | null;
      lastError?: string | null;
      completedAt?: Date | null;
    },
  ): Promise<void>;
  insertDeliveryAttempt(input: {
    messageId: string;
    attempt: number;
    outcome: string;
    error: string | null;
    workerId: string;
  }): Promise<void>;
  insertDeadLetter(input: {
    id: string;
    messageId: string | null;
    reason: string;
    detail: string;
    attemptCount: number;
  }): Promise<DeadLetter>;
  findDeadLetter(id: string): Promise<DeadLetter | null>;
  findOpenDeadLetter(messageId: string): Promise<DeadLetter | null>;
  listDeadLetters(filter: DeadLetterListFilter): Promise<Page<DeadLetter>>;
  markDeadLetterRedriven(id: string, actorId: string): Promise<DeadLetter>;
  getProcessing(messageId: string): Promise<ProcessingRow | null>;
  metrics(): Promise<MessagingMetrics>;
  listActiveRouting(): Promise<Array<{ departmentId: string; agentIds: string[] }>>;
  listArchivedDepartments(): Promise<string[]>;
  listArchivedAgents(): Promise<Array<{ departmentId: string; agentId: string }>>;
}

export interface ObjectiveLimitsRow {
  maxInferenceRequests: number;
  maxOutputTokens: number;
  maxEstimatedTokens: number;
  maxTaskAttempts: number;
  maxConcurrentTasks: number;
  maxDurationMs: number;
}

export interface ObjectiveRun {
  id: string;
  submitterPrincipalId: string;
  objective: string;
  status: ObjectiveStatus;
  correlationId: string;
  failureReason: string | null;
  finalOutput: string | null;
  executionAuthorized: boolean;
  planCorrections: number;
  memoryProfile: "shared" | "split";
  primaryModelId: string;
  operationalModelId: string | null;
  limits: ObjectiveLimitsRow;
  consumedRequests: number;
  reservedRequests: number;
  consumedInputTokens: number;
  consumedOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reservedOutputTokens: number;
  estimatedCostUsdMicros: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ObjectiveTaskRecord {
  id: string;
  objectiveId: string;
  localId: string;
  departmentId: string;
  departmentSlug: TaskType;
  taskType: TaskType;
  objective: string;
  expectedOutput: string;
  dependsOn: string[];
  status: TaskStatus;
  attempt: number;
  assignedAgentId: string | null;
  requestMessageId: string | null;
  error: string | null;
  resultSummary: string | null;
  deadline: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  objectiveCreatedAt: string;
}

export interface InferenceRow {
  id: string;
  objectiveId: string;
  taskId: string | null;
  attempt: number;
  purpose: string;
  registryModelId: string;
  intendedModelId: string;
  requestedAlias: string;
  status: string;
  reservedOutputTokens: number;
  idempotencyKey: string;
  responseText: string | null;
  error: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
}

export interface RuntimeRow {
  modelId: string;
  displayName: string;
  registryStatus: string;
  runtimeStatus: RuntimeStatus;
  expectedAlias: string | null;
  loadedModelId: string | null;
  endpointUrl: string | null;
  lastError: string | null;
  probedAt: string | null;
}

export interface HeartbeatRow {
  workerId: string;
  role: string;
  beatAt: string;
  detail: string | null;
}

export interface EligibleAgent {
  id: string;
  principalId: string;
  departmentId: string;
  role: RoleName;
  status: AgentStatus;
  name: string;
}

export interface ObjectiveRepository {
  insertRun(input: {
    id: string;
    submitterPrincipalId: string;
    objective: string;
    correlationId: string;
    executionAuthorized: boolean;
    memoryProfile: "shared" | "split";
    primaryModelId: string;
    operationalModelId: string | null;
    limits: ObjectiveLimitsRow;
  }): Promise<ObjectiveRun>;
  getRun(id: string): Promise<ObjectiveRun | null>;
  lockRun(id: string): Promise<ObjectiveRun | null>;
  saveRun(
    id: string,
    patch: Partial<{
      status: ObjectiveRun["status"];
      failureReason: string | null;
      finalOutput: string | null;
      executionAuthorized: boolean;
      planCorrections: number;
      startedAt: Date | null;
      completedAt: Date | null;
    }>,
  ): Promise<ObjectiveRun>;
  listRuns(filter: {
    limit: number;
    cursor: DecodedCursor | null;
    status?: ObjectiveRun["status"];
    submitterPrincipalId?: string;
  }): Promise<Page<ObjectiveRun>>;
  insertPlan(input: {
    id: string;
    objectiveId: string;
    version: number;
    body: Record<string, unknown>;
    valid: boolean;
    errors: string[];
  }): Promise<void>;
  latestPlan(
    objectiveId: string,
  ): Promise<{ version: number; valid: boolean; body: Record<string, unknown>; errors: string[] } | null>;
  insertTasks(
    tasks: Array<{
      id: string;
      objectiveId: string;
      localId: string;
      departmentId: string;
      departmentSlug: ObjectiveTaskRecord["departmentSlug"];
      taskType: ObjectiveTaskRecord["taskType"];
      objective: string;
      expectedOutput: string;
      dependsOn: string[];
    }>,
  ): Promise<void>;
  listTasks(objectiveId?: string): Promise<ObjectiveTaskRecord[]>;
  lockTask(id: string): Promise<ObjectiveTaskRecord | null>;
  saveTask(
    id: string,
    patch: Partial<{
      status: ObjectiveTaskRecord["status"];
      attempt: number;
      assignedAgentId: string | null;
      requestMessageId: string | null;
      error: string | null;
      resultSummary: string | null;
      deadline: Date | null;
      leaseOwner: string | null;
      leaseUntil: Date | null;
      startedAt: Date | null;
      completedAt: Date | null;
    }>,
  ): Promise<void>;
  insertAssignment(input: {
    id: string;
    taskId: string;
    agentId: string;
    departmentId: string;
    attempt: number;
  }): Promise<void>;
  insertResult(input: {
    id: string;
    taskId: string;
    attempt: number;
    status: string;
    summary: string;
    messageId: string | null;
  }): Promise<void>;
  findResult(taskId: string, attempt: number): Promise<{ id: string } | null>;
  insertInference(input: {
    id: string;
    objectiveId: string;
    taskId: string | null;
    attempt: number;
    purpose: string;
    registryModelId: string;
    intendedModelId: string;
    requestedAlias: string;
    reservedOutputTokens: number;
    idempotencyKey: string;
    leaseOwner: string;
    leaseUntil: Date;
  }): Promise<"created" | "exists">;
  getInference(key: string): Promise<InferenceRow | null>;
  getInferenceById(id: string): Promise<InferenceRow | null>;
  reopenInference(id: string, leaseOwner: string, leaseUntil: Date): Promise<void>;
  finishInference(
    id: string,
    patch: { status: string; responseText: string | null; error: string | null },
  ): Promise<void>;
  insertUsage(input: {
    requestId: string;
    inputTokens: number | null;
    outputTokens: number | null;
    tokenSource: string;
    servedModel: string;
    latencyMs: number;
    estimatedCostUsdMicros: number | null;
    overrideApplied: boolean;
  }): Promise<void>;
  reserve(input: {
    objectiveId: string;
    outputTokens: number;
    estimatedTokens: number;
  }): Promise<boolean>;
  releaseReservation(objectiveId: string, outputTokens: number): Promise<void>;
  reconcile(input: {
    objectiveId: string;
    reservedOutputTokens: number;
    observedInputTokens: number;
    observedOutputTokens: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostUsdMicros: number | null;
  }): Promise<void>;
  appendEvent(input: {
    id: string;
    objectiveId: string | null;
    eventType: string;
    summary: string;
  }): Promise<void>;
  listEvents(filter: {
    objectiveId: string;
    limit: number;
    cursor: DecodedCursor | null;
  }): Promise<Page<{ id: string; objectiveId: string | null; eventType: string; summary: string; createdAt: string }>>;
  hasEvent(objectiveId: string | null, eventType: string): Promise<boolean>;
  counts(): Promise<{
    objectives: Array<{ status: string; count: number }>;
    tasks: Array<{ status: string; count: number }>;
    inferenceRequests: number;
    observedOutputTokens: number;
    estimatedOutputTokens: number;
    unavailableUsage: number;
    estimatedCostUsdMicros: number | null;
  }>;
  upsertRuntime(input: {
    modelId: string;
    runtimeStatus: RuntimeStatus;
    endpointUrl: string | null;
    expectedAlias: string | null;
    loadedModelId: string | null;
    lastError: string | null;
    probedAt: Date | null;
  }): Promise<void>;
  listRuntimes(): Promise<RuntimeRow[]>;
  heartbeat(input: { workerId: string; role: string; beatAt: Date; detail: string | null }): Promise<void>;
  listHeartbeats(): Promise<HeartbeatRow[]>;
  findDepartmentBySlug(slug: string): Promise<{ id: string; slug: string; status: string } | null>;
  listEligibleAgents(departmentId: string): Promise<EligibleAgent[]>;
  findAgent(id: string): Promise<EligibleAgent | null>;
}

export interface Repositories {
  departments: DepartmentRepository;
  agents: AgentRepository;
  principals: PrincipalRepository;
  models: ModelRepository;
  approvals: ApprovalRepository;
  audit: AuditRepository;
  lifecycle: LifecycleRepository;
  messages: MessageRepository;
  objectives: ObjectiveRepository;
}

export interface Persistence {
  repos: Repositories;
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type { AgentRuntimeView };
