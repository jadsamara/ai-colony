export const SPECIFICATION_VERSION = "1.0.0" as const;

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

export const ROLE_NAMES = [
  "system_administrator",
  "ceo_agent",
  "orchestration_agent",
  "evolution_agent",
  "monitoring_agent",
  "department_agent",
  "read_only_observer",
] as const;

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
  "CAPABILITY_GAP",
  "LEARNING_OBJECTIVE",
  "KNOWLEDGE_TRANSFER",
  "KNOWLEDGE_VALIDATION",
  "LEARNING_CYCLE_RESULT",
  "CAPABILITY_UPDATE",
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

export const IACP_PROTOCOL_VERSION = "1.0" as const;

export const IACP_PAYLOAD_SCHEMA_VERSION = "1.0" as const;

export const MAX_MESSAGE_PAYLOAD_BYTES = 65_536;

export const SYSTEM_ADMINISTRATOR_ID = "00000000-0000-4000-8000-000000000001";

export const QWEN3_8B_MODEL_ID = "00000000-0000-4000-8000-000000000101";
export const QWEN3_4B_MODEL_ID = "00000000-0000-4000-8000-000000000102";
export const GEMMA3_270M_MODEL_ID = "00000000-0000-4000-8000-000000000103";

export const TRAINING_PROFILE_ID = "gemma3-270m-math-v1" as const;

export const TRAINING_RUN_STATUSES = [
  "proposed",
  "awaiting_approval",
  "queued",
  "preparing",
  "training",
  "evaluating",
  "completed",
  "failed",
  "cancelled",
] as const;

export const CANDIDATE_STATUSES = ["experimental", "rejected", "approved", "retired", "revoked", "quarantined"] as const;

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

export const MEMORY_SCOPES = ["agent", "department", "colony"] as const;
export const MEMORY_CATEGORIES = ["episodic", "semantic", "procedural", "failure", "operational"] as const;
export const MEMORY_PROVENANCE = ["model_generated", "system_observed", "user_provided", "externally_verified"] as const;
export const MEMORY_STATUSES = ["candidate", "validated", "disputed", "superseded", "archived", "expired", "forgetting_requested", "forgotten"] as const;
export const MEMORY_PROMOTION_STATUSES = ["pending", "approved", "rejected"] as const;
/** Measured from Ollama `embeddinggemma` via POST /api/embed. Do not mix another model into this space. */
export const EMBEDDING_DIMENSIONS = 768 as const;

export const OBJECTIVE_HARD_CAPS = {
  maxInferenceRequests: 24,
  maxOutputTokens: 16_384,
  maxEstimatedTokens: 65_536,
  maxTaskAttempts: 3,
  maxConcurrentTasks: 2,
  maxDurationMs: 60 * 60 * 1000,
  maxPlanCorrections: 2,
  maxTasks: 8,
  maxDependencyDepth: 4,
  objectiveText: 8_000,
} as const;

export const PERMANENT_DEPARTMENT_TYPES = ["system", "specialized", "experimental"] as const;
