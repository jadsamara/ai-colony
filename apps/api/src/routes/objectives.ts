import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  inferenceHealthSchema,
  monitoringOverviewSchema,
  objectiveCreateSchema,
  objectiveListQuerySchema,
  objectiveListResponseSchema,
  objectiveResponseSchema,
  objectiveTaskListResponseSchema,
  paginationQuerySchema,
  runtimeModelSchema,
  workflowEventListResponseSchema,
} from "@ai-colony/contracts";
import { OpenAICompatibleProvider } from "@ai-colony/inference";
import { errorResponses, requestContext } from "./common.js";
import { currentModelHealth } from "./live-model.js";

export async function registerObjectiveRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const inference = app.services.inference;

  route.post(
    "/api/v1/objectives",
    {
      schema: {
        tags: ["objectives"],
        body: objectiveCreateSchema,
        response: { 201: objectiveResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const objective = await app.services.objectives.submit(requestContext(request), request.body);
      return reply.status(201).send({ objective });
    },
  );

  route.get(
    "/api/v1/objectives",
    {
      schema: {
        tags: ["objectives"],
        querystring: objectiveListQuerySchema,
        response: { 200: objectiveListResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.objectives.list(requestContext(request), request.query),
  );

  route.get(
    "/api/v1/objectives/:objectiveId",
    {
      schema: {
        tags: ["objectives"],
        params: z.object({ objectiveId: z.string().uuid() }),
        response: { 200: objectiveResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      objective: await app.services.objectives.get(requestContext(request), request.params.objectiveId),
    }),
  );

  route.get(
    "/api/v1/objectives/:objectiveId/tasks",
    {
      schema: {
        tags: ["objectives"],
        params: z.object({ objectiveId: z.string().uuid() }),
        response: { 200: objectiveTaskListResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      tasks: await app.services.objectives.tasks(requestContext(request), request.params.objectiveId),
    }),
  );

  route.get(
    "/api/v1/objectives/:objectiveId/events",
    {
      schema: {
        tags: ["objectives"],
        params: z.object({ objectiveId: z.string().uuid() }),
        querystring: paginationQuerySchema,
        response: { 200: workflowEventListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.objectives.events(requestContext(request), request.params.objectiveId, request.query),
  );

  route.post(
    "/api/v1/objectives/:objectiveId/cancel",
    {
      schema: {
        tags: ["objectives"],
        params: z.object({ objectiveId: z.string().uuid() }),
        response: { 200: objectiveResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      objective: await app.services.objectives.cancel(requestContext(request), request.params.objectiveId),
    }),
  );

  route.post(
    "/api/v1/objectives/:objectiveId/approve",
    {
      schema: {
        tags: ["objectives"],
        params: z.object({ objectiveId: z.string().uuid() }),
        response: { 200: objectiveResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      objective: await app.services.objectives.approve(requestContext(request), request.params.objectiveId),
    }),
  );

  route.get(
    "/api/v1/inference/models",
    {
      schema: {
        tags: ["inference"],
        response: { 200: z.object({ models: z.array(runtimeModelSchema) }), ...errorResponses },
      },
    },
    async (request) => ({
      models: (await app.services.objectives.health(requestContext(request), inference.route)).models,
    }),
  );

  route.get(
    "/api/v1/inference/health",
    {
      schema: {
        tags: ["inference"],
        response: { 200: inferenceHealthSchema, ...errorResponses },
      },
    },
    async (request) => {
      const persisted = await app.services.objectives.health(requestContext(request), inference.route);
      return { ...persisted, live: await currentModelHealth(app, request, persisted.models) };
    },
  );

  route.post(
    "/api/v1/inference/probe",
    {
      schema: {
        tags: ["inference"],
        response: { 200: inferenceHealthSchema, ...errorResponses },
      },
    },
    async (request) => {
      const context = requestContext(request);
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const probe = await provider.probe();
      await app.services.objectives.recordProbe({
        modelId: inference.primaryModelId,
        endpointUrl: inference.baseUrl,
        expectedAlias: inference.route.alias,
        reachable: probe.reachable,
        modelIds: probe.modelIds,
        error: probe.error,
      });
      return app.services.objectives.health(context, inference.route);
    },
  );

  route.get(
    "/api/v1/monitoring/overview",
    {
      schema: {
        tags: ["monitoring"],
        response: { 200: monitoringOverviewSchema, ...errorResponses },
      },
    },
    async (request) => {
      const overview = await app.services.objectives.overview(requestContext(request), inference.staleAfterMs);
      return { ...overview, live: await currentModelHealth(app, request, overview.models) };
    },
  );
}
