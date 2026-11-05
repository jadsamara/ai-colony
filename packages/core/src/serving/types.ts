export const DEDICATED_SERVING_POLICY_VERSION = "m12-dedicated-serving-v1";

export const SERVING_PROVIDERS = ["ollama", "vllm", "sglang"] as const;
export type ServingProvider = (typeof SERVING_PROVIDERS)[number];

export const SERVING_STATUSES = ["configured", "starting", "ready", "unavailable", "stopped"] as const;
export type ServingStatus = (typeof SERVING_STATUSES)[number];

export interface DepartmentSource {
  id: string;
  slug: string;
  name: string;
  status: string;
  purpose: string;
}

export interface AgentSource {
  id: string;
  departmentId: string;
}

export interface ExecutionLimits {
  maxSteps: number;
  maxWallClockMs: number;
  maxTokens: number;
  maxToolCalls: number;
  maxRetries: number;
  maxConcurrentRequests: number;
  dailyRequestLimit: number;
}

export interface DepartmentProfile {
  departmentId: string;
  slug: string;
  name: string;
  agentId: string;
  role: string;
  instructions: string;
  tools: readonly string[];
  collaborators: readonly string[];
  memoryNamespace: string;
  limits: ExecutionLimits;
  modelRegistryId: string;
  modelVersion: string;
}

export interface DedicatedServingInstance {
  instanceId: string;
  departmentId: string;
  agentId: string;
  provider: ServingProvider;
  endpointReference: string;
  normalizedEndpoint: string;
  modelRegistryId: string;
  modelVersion: string;
  artifactDigest: string | null;
  deploymentMode: "dedicated";
  status: ServingStatus;
  resourcePolicyId: string;
}

export interface DedicatedRoutingContext {
  instances: readonly DedicatedServingInstance[];
  requestedEndpoint: string | null;
  requestedInstanceId: string | null;
  pinnedInstanceId: string | null;
  pinnedModelVersion: string | null;
}

export interface AgentMessage {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  senderDepartmentId: string;
  recipientDepartmentId: string;
  taskId: string;
  correlationId: string;
  messageType: "COLLABORATION_REQUEST" | "COLLABORATION_RESULT";
  payload: { objective: string; result?: string };
  authorization: "governed";
  deliveryStatus: "accepted" | "delivered" | "dead_letter";
  idempotencyKey: string;
  createdAt: string;
}

export interface ToolRequest {
  name: string;
  input: string;
  idempotencyKey: string;
}

export interface ToolResult {
  name: string;
  output: string;
  repeated: boolean;
}

export interface MemoryQuery {
  departmentId: string;
  namespace: string;
  query: string;
}

export interface MemoryProposal {
  departmentId: string;
  namespace: string;
  summary: string;
}

export interface AgentTaskState {
  taskId: string;
  objective: string;
  correlationId: string;
  reportTo: string | null;
  status: "accepted" | "running" | "completed" | "failed" | "interrupted";
  step: number;
  tokens: number;
  toolCalls: number;
  retries: number;
  result: string | null;
  failureReason: string | null;
  toolKeys: string[];
  servingInstanceId: string;
  modelVersion: string;
  endpointReference: string;
  startedAtMs: number;
}

export interface AgentCheckpoint {
  agentId: string;
  departmentId: string;
  task: AgentTaskState;
  savedAt: string;
}

export interface AgentStatusReport {
  agentId: string;
  departmentId: string;
  servingInstanceId: string;
  endpointReference: string;
  modelVersion: string;
  status: ServingStatus | AgentTaskState["status"];
  activeTasks: number;
}
