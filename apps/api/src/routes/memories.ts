import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  memoryConsolidateResponseSchema,
  memoryConsolidateSchema,
  memoryCreateSchema,
  memoryDecisionSchema,
  memoryDisputeSchema,
  memoryHistoryResponseSchema,
  memoryListQuerySchema,
  memoryListResponseSchema,
  memoryMetricsSchema,
  memoryPromoteSchema,
  memoryPromotionListResponseSchema,
  memoryPromotionResponseSchema,
  memoryResponseSchema,
  memorySearchResponseSchema,
  memorySearchSchema,
  memoryUpdateSchema,
} from "@ai-colony/contracts";
import { buildPage, decodeCursor } from "@ai-colony/core";
import { errorResponses, requestContext } from "./common.js";

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const memories = app.services.memories;

  route.post(
    "/api/v1/memories",
    { schema: { tags: ["memory"], body: memoryCreateSchema, response: { 201: memoryResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const memory = await memories.createMemory(requestContext(request), request.body);
      return reply.status(201).send({ memory });
    },
  );

  route.get(
    "/api/v1/memories",
    { schema: { tags: ["memory"], querystring: memoryListQuerySchema, response: { 200: memoryListResponseSchema, ...errorResponses } } },
    async (request) => {
      const rows = await memories.listMemories(requestContext(request), {
        scope: request.query.scope,
        category: request.query.category,
        status: request.query.status,
        cursor: request.query.cursor ? decodeCursor(request.query.cursor) : undefined,
        limit: request.query.limit,
      });
      return buildPage(rows, request.query.limit, (memory) => ({ createdAt: memory.createdAt, id: memory.id }));
    },
  );

  route.post(
    "/api/v1/memories/search",
    { schema: { tags: ["memory"], body: memorySearchSchema, response: { 200: memorySearchResponseSchema, ...errorResponses } } },
    async (request) => memories.searchMemories(requestContext(request), request.body),
  );

  route.post(
    "/api/v1/memories/consolidate",
    { schema: { tags: ["memory"], body: memoryConsolidateSchema, response: { 200: memoryConsolidateResponseSchema, ...errorResponses } } },
    async (request) => memories.consolidateMemories(requestContext(request), request.body),
  );

  route.get(
    "/api/v1/memory/metrics",
    { schema: { tags: ["memory"], response: { 200: memoryMetricsSchema, ...errorResponses } } },
    async (request) => memories.metrics(requestContext(request)),
  );

  route.get(
    "/api/v1/memory-promotions",
    { schema: { tags: ["memory"], response: { 200: memoryPromotionListResponseSchema, ...errorResponses } } },
    async (request) => {
      const rows = await memories.listPromotions(requestContext(request));
      return buildPage(rows, 100, (promotion) => ({ createdAt: promotion.createdAt, id: promotion.id }));
    },
  );

  route.post(
    "/api/v1/memory-promotions/:promotionId/approve",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ promotionId: z.string().uuid() }),
        body: memoryDecisionSchema,
        response: { 200: memoryPromotionResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      promotion: await memories.approvePromotion(requestContext(request), request.params.promotionId, request.body.reason),
    }),
  );

  route.post(
    "/api/v1/memory-promotions/:promotionId/reject",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ promotionId: z.string().uuid() }),
        body: memoryDecisionSchema,
        response: { 200: memoryPromotionResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      promotion: await memories.rejectPromotion(requestContext(request), request.params.promotionId, request.body.reason),
    }),
  );

  route.get(
    "/api/v1/memories/:memoryId",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ memoryId: z.string().uuid() }),
        response: { 200: memoryResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({ memory: await memories.getMemory(requestContext(request), request.params.memoryId) }),
  );

  route.post(
    "/api/v1/memories/:memoryId",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ memoryId: z.string().uuid() }),
        body: memoryUpdateSchema,
        response: { 200: memoryResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      memory: await memories.updateMemory(requestContext(request), request.params.memoryId, request.body),
    }),
  );

  route.get(
    "/api/v1/memories/:memoryId/history",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ memoryId: z.string().uuid() }),
        response: { 200: memoryHistoryResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      revisions: await memories.getMemoryHistory(requestContext(request), request.params.memoryId),
    }),
  );

  route.post(
    "/api/v1/memories/:memoryId/archive",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ memoryId: z.string().uuid() }),
        response: { 200: memoryResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({ memory: await memories.archiveMemory(requestContext(request), request.params.memoryId) }),
  );

  route.post(
    "/api/v1/memories/:memoryId/promote",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ memoryId: z.string().uuid() }),
        body: memoryPromoteSchema,
        response: { 201: memoryPromotionResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const promotion = await memories.proposePromotion(requestContext(request), request.params.memoryId, request.body.reason);
      return reply.status(201).send({ promotion });
    },
  );

  route.post(
    "/api/v1/memories/:memoryId/dispute",
    {
      schema: {
        tags: ["memory"],
        params: z.object({ memoryId: z.string().uuid() }),
        body: memoryDisputeSchema,
        response: { 200: z.object({ status: z.literal("disputed") }), ...errorResponses },
      },
    },
    async (request) => {
      await memories.disputeMemory(requestContext(request), request.params.memoryId, request.body.otherMemoryId, request.body.reason);
      return { status: "disputed" as const };
    },
  );
}
