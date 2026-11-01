import { join } from "node:path";
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
  DEFAULT_MEMORY_LIMITS,
  MemoryService,
  EvaluationService,
  CollaborationService,
  DepartmentLearningService,
  MlxTrainingProvider,
  ObjectiveService,
  ScriptedTrainingProvider,
  TrainingService,
  type EmbeddingProvider,
  type Persistence,
  type TrainingProvider,
} from "@ai-colony/core";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import { loadInferenceConfig, OllamaEmbeddingProvider, routeFromConfig } from "@ai-colony/inference";
import type { AppConfig } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import { registerCorrelation } from "./plugins/correlation.js";
import { registerErrors } from "./plugins/errors.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerDepartmentRoutes } from "./routes/departments.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerEvaluationRoutes } from "./routes/evaluation.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerTrainingRoutes } from "./routes/training.js";
import { registerObjectiveRoutes } from "./routes/objectives.js";
import "./types.js";

export interface BuildAppOptions {
  config: AppConfig;
  persistence: Persistence;
  embeddings?: EmbeddingProvider;
  trainingProvider?: TrainingProvider;
  trainingRoots?: { artifacts: string; checkpoints: string };
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
  const trainingProvider =
    options.trainingProvider ??
    (process.env.TRAINING_PROVIDER === "mlx"
      ? new MlxTrainingProvider({
          pythonPath: process.env.TRAINING_PYTHON ?? join(process.cwd(), "services/training/.venv/bin/python"),
          scriptsDir: join(process.cwd(), "services/training"),
        })
      : new ScriptedTrainingProvider());
  const trainingRoots = options.trainingRoots ?? {
    artifacts: join(process.cwd(), "services/training/artifacts"),
    checkpoints: join(process.cwd(), "services/training/checkpoints"),
  };
  const memories = new MemoryService(
    options.persistence,
    authorizer,
    options.embeddings ??
      new OllamaEmbeddingProvider({
        baseUrl: inferenceConfig.embeddingBaseUrl,
        model: inferenceConfig.embeddingModel,
        dimensions: inferenceConfig.embeddingDimensions,
        timeoutMs: inferenceConfig.embeddingTimeoutMs,
        maxConcurrency: inferenceConfig.embeddingConcurrency,
        transportRetries: inferenceConfig.embeddingRetries,
      }),
    {
      ...DEFAULT_MEMORY_LIMITS,
      topK: inferenceConfig.memoryTopK,
      contextTokens: inferenceConfig.memoryContextTokens,
      maxWritesPerObjective: inferenceConfig.memoryMaxWritesPerObjective,
      dimensions: inferenceConfig.embeddingDimensions,
    },
  );
  const training = new TrainingService(options.persistence, authorizer, trainingProvider, messages, trainingRoots);
  const evaluation = new EvaluationService(options.persistence, authorizer, trainingProvider, messages, trainingRoots);
  const learning = new DepartmentLearningService(options.persistence, authorizer, messages, training, evaluation, memories);
  const collaboration = new CollaborationService(options.persistence, authorizer, memories, messages);
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
    memories,
    inference: {
      baseUrl: inferenceConfig.baseUrl,
      apiKey: inferenceConfig.apiKey,
      primaryModelId: QWEN3_8B_MODEL_ID,
      staleAfterMs: options.config.runtimeStaleAfterMs,
      route: routeFromConfig(inferenceConfig),
    },
    training,
    evaluation,
    learning,
    collaboration,
  });
  app.decorateRequest("actor", null);
  app.decorateRequest("correlationId", "");

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "AI Colony API",
        version: "1.0.0",
        description:
          "AI Colony control plane, IACP workflows, and scoped memory. Objectives are planned by the CEO graph and dispatched through RabbitMQ. Model output and retrieved memory cannot grant permissions, change budgets, create departments, or mark a model ready. Colony memory is published only by an approved promotion. AUTH_MODE=disabled fail-closes every non-public route. Development bearer authentication is refused when NODE_ENV=production. Stored budgets do not limit cloud spend.",
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
  await registerTrainingRoutes(app);
  await registerEvaluationRoutes(app);
  await registerLearningRoutes(app);
  await registerModelRoutes(app);
  await registerMessageRoutes(app);
  await registerObjectiveRoutes(app);
  await registerMemoryRoutes(app);
  await registerGovernanceRoutes(app);

  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await runtime.reconcileStaleAgents();
  await app.services.training.recoverInterrupted();
  app.addHook("onClose", async () => {
    await runtime.shutdown();
  });

  return app;
}
