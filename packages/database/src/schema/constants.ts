export const DEPARTMENT_STATUSES = [
  "proposed",
  "provisioning",
  "active",
  "paused",
  "deprecated",
  "archived",
  "failed",
] as const;

export const DEPARTMENT_TYPES = ["system", "specialized", "temporary", "experimental"] as const;

export const CREATION_SOURCES = ["seed", "api"] as const;

export const AGENT_STATUSES = [
  "registered",
  "initializing",
  "idle",
  "running",
  "paused",
  "stopping",
  "stopped",
  "failed",
  "archived",
] as const;

export const ROLE_NAMES = [
  "system_administrator",
  "ceo_agent",
  "orchestration_agent",
  "evolution_agent",
  "monitoring_agent",
  "department_agent",
  "read_only_observer",
] as const;

export const MODEL_STATUSES = [
  "registered",
  "not_deployed",
  "deploying",
  "available",
  "unavailable",
  "deprecated",
] as const;

export const DEPLOYMENT_TARGETS = ["none", "local", "cloud-run", "external"] as const;

export const QUANTIZATIONS = ["none", "int8", "int4", "fp8", "fp16", "bf16", "fp32"] as const;

export const APPROVAL_TYPES = [
  "department_create",
  "department_activate",
  "budget_change",
] as const;

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;

export const APPROVAL_TARGET_TYPES = ["department", "agent"] as const;

export const PRINCIPAL_TYPES = ["system", "human", "agent"] as const;

export const ACTOR_TYPES = ["system", "human", "agent"] as const;

export const MESSAGE_TYPES = [
  "TASK_REQUEST",
  "TASK_RESULT",
  "COLLABORATION_REQUEST",
  "KNOWLEDGE_SHARE",
  "TRAINING_REQUEST",
  "MODEL_CANDIDATE",
  "EVALUATION_RESULT",
  "RESOURCE_REQUEST",
  "HEALTH_ALERT",
  "EVOLUTION_PROPOSAL",
] as const;

export const MESSAGE_STATUSES = [
  "accepted",
  "published",
  "delivered",
  "acknowledged",
  "rejected",
  "expired",
  "dead_lettered",
] as const;

export const ADDRESSING_MODES = ["agent", "department"] as const;

export const OUTBOX_STATUSES = ["pending", "publishing", "published", "failed"] as const;

export const PROCESSING_STATUSES = [
  "processing",
  "recorded",
  "acknowledged",
  "rejected",
  "expired",
  "dead_lettered",
  "retry_scheduled",
] as const;

export const DEAD_LETTER_STATUSES = ["open", "redriven"] as const;

export const OBJECTIVE_STATUSES = [
  "submitted",
  "planning",
  "awaiting_approval",
  "scheduled",
  "running",
  "synthesizing",
  "completed",
  "failed",
  "cancelled",
] as const;

export const TASK_STATUSES = [
  "pending",
  "ready",
  "dispatched",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
] as const;

export const TASK_TYPES = ["math", "science", "research", "reasoning"] as const;

export const RUNTIME_STATUSES = [
  "not_deployed",
  "loading",
  "ready",
  "unavailable",
  "failed",
] as const;

export const INFERENCE_REQUEST_STATUSES = [
  "reserved",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const TOKEN_SOURCES = ["observed", "unavailable", "estimated"] as const;
