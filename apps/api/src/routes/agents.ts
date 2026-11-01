import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentCreateSchema,
  agentFailSchema,
  agentListQuerySchema,
  agentListResponseSchema,
  agentResponseSchema,
  agentRetrySchema,
  agentRoleChangeSchema,
  agentStatusResponseSchema,
  agentUpdateSchema,
  executorAttachResponseSchema,
  executorAttachSchema,
  lifecycleEventListResponseSchema,
  paginationQuerySchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    "/api/v1/agents",
    {
      schema: {
        tags: ["agents"],
        body: agentCreateSchema,
        response: { 201: agentResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const ctx = requestContext(request);
      const agent = await app.services.agents.create(ctx, request.body);
      const runtime = await app.services.runtime.getStatus(agent.id);
      return reply.status(201).send({ agent, runtime });
    },
  );

  route.get(
    "/api/v1/agents",
    {
      schema: {
        tags: ["agents"],
        querystring: agentListQuerySchema,
        response: { 200: agentListResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.agents.list(request.query),
  );

  route.get(
    "/api/v1/agents/:id",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      agent: await app.services.agents.get(request.params.id),
      runtime: await app.services.runtime.getStatus(request.params.id),
    }),
  );

  route.patch(
    "/api/v1/agents/:id",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        body: agentUpdateSchema,
        response: { 200: agentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const agent = await app.services.agents.update(
        requestContext(request),
        request.params.id,
        request.body,
      );
      return { agent, runtime: await app.services.runtime.getStatus(agent.id) };
    },
  );

  route.post(
    "/api/v1/agents/:id/role",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        body: agentRoleChangeSchema,
        response: { 200: agentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const agent = await app.services.agents.assignRole(
        requestContext(request),
        request.params.id,
        request.body.role,
      );
      return { agent, runtime: await app.services.runtime.getStatus(agent.id) };
    },
  );

  route.post(
    "/api/v1/agents/:id/executor",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        body: executorAttachSchema,
        response: { 200: executorAttachResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.attachExecutor(
        requestContext(request),
        request.params.id,
      ),
    }),
  );

  route.post(
    "/api/v1/agents/:id/initialize",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.initialize(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/agents/:id/start",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.start(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/agents/:id/yield",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.yieldExecution(
        requestContext(request),
        request.params.id,
      ),
    }),
  );

  route.post(
    "/api/v1/agents/:id/stop",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.stop(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/agents/:id/pause",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.pause(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/agents/:id/resume",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.resume(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/agents/:id/fail",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        body: agentFailSchema,
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.fail(
        requestContext(request),
        request.params.id,
        request.body.reason,
      ),
    }),
  );

  route.post(
    "/api/v1/agents/:id/retry",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        body: agentRetrySchema,
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.retry(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/agents/:id/archive",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      runtime: await app.services.runtime.archive(requestContext(request), request.params.id),
    }),
  );

  route.get(
    "/api/v1/agents/:id/status",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: agentStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({ runtime: await app.services.runtime.getStatus(request.params.id) }),
  );

  route.get(
    "/api/v1/agents/:id/lifecycle-events",
    {
      schema: {
        tags: ["agents"],
        params: z.object({ id: z.string().uuid() }),
        querystring: paginationQuerySchema,
        response: { 200: lifecycleEventListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.runtime.listEvents(request.params.id, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
  );
}
