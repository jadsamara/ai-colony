import type { Actor } from "@ai-colony/contracts";
import type {
  AgentRuntime,
  AgentService,
  ApprovalService,
  AuditQueryService,
  DepartmentService,
  IdentityService,
  MessagingService,
  ModelService,
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
