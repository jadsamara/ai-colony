import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  AgentRuntime,
  AgentService,
  ApprovalService,
  AuditQueryService,
  Authorizer,
  DepartmentService,
  DEFAULT_MESSAGING_POLICY,
  IdentityService,
  MessagingService,
  ModelService,
  ObjectiveService,
  type Persistence,
} from "@ai-colony/core";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import { loadInferenceConfig, routeFromConfig } from "@ai-colony/inference";
import type { AppConfig } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import { registerCorrelation } from "./plugins/correlation.js";
import { registerErrors } from "./plugins/errors.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerDepartmentRoutes } from "./routes/departments.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerObjectiveRoutes } from "./routes/objectives.js";
import "./types.js";

export interface BuildAppOptions {
  config: AppConfig;
  persistence: Persistence;
  checkReady?: () => Promise<boolean>;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: ["req.headers.authorization"],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const authorizer = new Authorizer();
  const inferenceConfig = loadInferenceConfig(process.env);
  const messages = new MessagingService(options.persistence, authorizer, DEFAULT_MESSAGING_POLICY);
  const runtime = new AgentRuntime(
    options.persistence,
    authorizer,
    options.config.runtimeStaleAfterMs,
  );
  app.decorate("services", {
    identity: new IdentityService(options.persistence),
    departments: new DepartmentService(options.persistence, authorizer),
    agents: new AgentService(options.persistence, authorizer),
    runtime,
    approvals: new ApprovalService(
      options.persistence,
      authorizer,
      new DepartmentService(options.persistence, authorizer),
    ),
    models: new ModelService(options.persistence, authorizer),
    audit: new AuditQueryService(options.persistence, authorizer),
    messages,
    objectives: new ObjectiveService(options.persistence, authorizer, messages),
    inference: {
      baseUrl: inferenceConfig.baseUrl,
      apiKey: inferenceConfig.apiKey,
      primaryModelId: QWEN3_8B_MODEL_ID,
      staleAfterMs: options.config.runtimeStaleAfterMs,
      route: routeFromConfig(inferenceConfig),
    },
  });
  app.decorateRequest("actor", null);
  app.decorateRequest("correlationId", "");

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "AI Colony API",
        version: "1.0.0",
        description:
          "AI Colony control plane and IACP workflows. Objectives are planned by the CEO graph and dispatched through RabbitMQ. Model output cannot grant permissions, change budgets, create departments, or mark a model ready. Registry metadata is not deployment. AUTH_MODE=disabled fail-closes every non-public route. Development bearer authentication is refused when NODE_ENV=production. Stored budgets do not limit cloud spend.",
      },
      components: {
        securitySchemes: {
          developmentBearer: {
            type: "http",
            scheme: "bearer",
            description:
              "Development only. The bearer token is a principal UUID. Disabled unless AUTH_MODE=development, and refused when NODE_ENV=production.",
          },
        },
      },
      security: [{ developmentBearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  registerCorrelation(app);
  registerErrors(app);
  registerAuth(app, options.config);
  await registerHealthRoutes(
    app,
    options.checkReady ??
      (async () => {
        try {
          await options.persistence.ping();
          return true;
        } catch {
          return false;
        }
      }),
  );
  await registerDepartmentRoutes(app);
  await registerAgentRoutes(app);
  await registerModelRoutes(app);
  await registerMessageRoutes(app);
  await registerObjectiveRoutes(app);
  await registerGovernanceRoutes(app);

  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await runtime.reconcileStaleAgents();
  app.addHook("onClose", async () => {
    await runtime.shutdown();
  });

  return app;
}
