import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  deadLetterListQuerySchema,
  deadLetterListResponseSchema,
  deadLetterRedriveResponseSchema,
  messageGetResponseSchema,
  messageListQuerySchema,
  messageListResponseSchema,
  messagePublishSchema,
  messageRejectSchema,
  messageResponseSchema,
  messageStatusResponseSchema,
  messagingMetricsSchema,
} from "@ai-colony/contracts";
import { decodeCursor } from "@ai-colony/core";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ messageId: z.string().uuid() });
const correlationParams = z.object({ correlationId: z.string().uuid() });
const deadLetterParams = z.object({ deadLetterId: z.string().uuid() });

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    "/api/v1/messages",
    {
      schema: {
        tags: ["messages"],
        body: messagePublishSchema,
        response: { 200: messageResponseSchema, 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await app.services.messages.send(requestContext(request), request.body);
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  route.post(
    "/api/v1/messages/tasks",
    {
      schema: {
        tags: ["messages"],
        body: messagePublishSchema,
        response: { 200: messageResponseSchema, 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await app.services.messages.requestTask(requestContext(request), request.body);
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  route.post(
    "/api/v1/messages/knowledge",
    {
      schema: {
        tags: ["messages"],
        body: messagePublishSchema,
        response: { 200: messageResponseSchema, 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await app.services.messages.publishKnowledge(
        requestContext(request),
        request.body,
      );
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  route.post(
    "/api/v1/messages/collaboration",
    {
      schema: {
        tags: ["messages"],
        body: messagePublishSchema,
        response: { 200: messageResponseSchema, 201: messageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await app.services.messages.requestCollaboration(
        requestContext(request),
        request.body,
      );
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  route.get(
    "/api/v1/messages",
    {
      schema: {
        tags: ["messages"],
        querystring: messageListQuerySchema,
        response: { 200: messageListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.messages.list(requestContext(request), {
        limit: request.query.limit,
        cursor: request.query.cursor ? decodeCursor(request.query.cursor) : null,
        ...(request.query.messageType ? { messageType: request.query.messageType } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.correlationId ? { correlationId: request.query.correlationId } : {}),
        ...(request.query.inbox ? { inbox: request.query.inbox } : {}),
      }),
  );

  route.get(
    "/api/v1/messages/:messageId",
    {
      schema: {
        tags: ["messages"],
        params: idParams,
        response: { 200: messageGetResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      message: await app.services.messages.get(requestContext(request), request.params.messageId),
    }),
  );

  route.get(
    "/api/v1/messages/:messageId/status",
    {
      schema: {
        tags: ["messages"],
        params: idParams,
        response: { 200: messageStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.messages.getStatus(requestContext(request), request.params.messageId),
  );

  route.get(
    "/api/v1/conversations/:correlationId",
    {
      schema: {
        tags: ["messages"],
        params: correlationParams,
        querystring: messageListQuerySchema.pick({ limit: true, cursor: true }),
        response: { 200: messageListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.messages.getConversationHistory(
        requestContext(request),
        request.params.correlationId,
        {
          limit: request.query.limit,
          cursor: request.query.cursor ? decodeCursor(request.query.cursor) : null,
        },
      ),
  );

  route.post(
    "/api/v1/messages/:messageId/acknowledge",
    {
      schema: {
        tags: ["messages"],
        params: idParams,
        response: { 200: messageGetResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      message: await app.services.messages.acknowledge(
        requestContext(request),
        request.params.messageId,
      ),
    }),
  );

  route.post(
    "/api/v1/messages/:messageId/reject",
    {
      schema: {
        tags: ["messages"],
        params: idParams,
        body: messageRejectSchema,
        response: { 200: messageGetResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      message: await app.services.messages.reject(
        requestContext(request),
        request.params.messageId,
        request.body.reason,
      ),
    }),
  );

  route.get(
    "/api/v1/dead-letters",
    {
      schema: {
        tags: ["messages"],
        querystring: deadLetterListQuerySchema,
        response: { 200: deadLetterListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.messages.listDeadLetters(requestContext(request), {
        limit: request.query.limit,
        cursor: request.query.cursor ? decodeCursor(request.query.cursor) : null,
        ...(request.query.status ? { status: request.query.status } : {}),
      }),
  );

  route.post(
    "/api/v1/dead-letters/:deadLetterId/redrive",
    {
      schema: {
        tags: ["messages"],
        params: deadLetterParams,
        response: { 200: deadLetterRedriveResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.messages.redrive(requestContext(request), request.params.deadLetterId),
  );

  route.get(
    "/api/v1/messaging/metrics",
    {
      schema: {
        tags: ["messages"],
        response: { 200: messagingMetricsSchema, ...errorResponses },
      },
    },
    async (request) => app.services.messages.metrics(requestContext(request)),
  );
}
