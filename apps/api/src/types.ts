import type { Actor } from "@ai-colony/contracts";
import type {
  AgentRuntime,
  AgentService,
  ApprovalService,
  AuditQueryService,
  DepartmentService,
  IdentityService,
  MessagingService,
  EvaluationService,
  CollaborationService,
  DepartmentLearningService,
  MemoryService,
  ModelService,
  ExperimentService,
  TrainingService,
  InferenceRoute,
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
  memories: MemoryService;
  training: TrainingService;
  experiments: ExperimentService;
  evaluation: EvaluationService;
  learning: DepartmentLearningService;
  collaboration: CollaborationService;
  inference: {
    baseUrl: string;
    apiKey: string | null;
    primaryModelId: string;
    staleAfterMs: number;
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
  }
}
