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
