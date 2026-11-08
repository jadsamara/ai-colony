import type { Actor } from "@ai-colony/contracts";
import type { Database } from "@ai-colony/database";
import type {
  AgentRuntime,
  AgentService,
  ApprovalService,
  AuditQueryService,
  DepartmentService,
  IdentityService,
  MessagingService,
  EvaluationService,
  CapabilityLedgerService,
  CollaborationService,
  DepartmentLearningService,
  MemoryService,
  ModelService,
  ExperimentService,
  TrainingService,
  TrainingEvidenceService,
  InferenceRoute,
  AutonomyService,
  DialogueService,
  DepartmentJoinService,
  ConversationRunner,
  ClaimVerificationService,
  ObjectiveService,
} from "@ai-colony/core";

export interface AppServices {
  identity: IdentityService;
  departments: DepartmentService;
  agents: AgentService;
  runtime: AgentRuntime;
  approvals: ApprovalService;
  models: ModelService;
  audit: AuditQueryService;
  messages: MessagingService;
  objectives: ObjectiveService;
  autonomy: AutonomyService;
  dialogue: DialogueService;
  joins: DepartmentJoinService;
  runner: ConversationRunner;
  claims: ClaimVerificationService;
  memories: MemoryService;
  training: TrainingService;
  evidence: TrainingEvidenceService;
  experiments: ExperimentService;
  evaluation: EvaluationService;
  ledger: CapabilityLedgerService;
  learning: DepartmentLearningService;
  collaboration: CollaborationService;
  inference: {
    baseUrl: string;
    apiKey: string | null;
    primaryModelId: string;
    staleAfterMs: number;
    probeTimeoutMs: number;
    probeFreshnessMs: number;
    probeMinIntervalMs: number;
    route: InferenceRoute;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
    correlationId: string;
  }

  interface FastifyInstance {
    services: AppServices;
    database: Database | null;
  }
}
