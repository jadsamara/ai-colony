import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DIALOGUE_KINDS } from "@ai-colony/contracts";
import { DomainError } from "@ai-colony/core";
import { OpenAICompatibleProvider } from "@ai-colony/inference";
import { routeWithDepartmentEndpoints } from "../conversation-inference.js";
import { errorResponses, requestContext } from "./common.js";

const json = z.any();
const idParams = z.object({ id: z.string().uuid() });
const participantParams = z.object({ id: z.string().uuid(), departmentId: z.string().uuid() });
const objectiveParams = z.object({ objectiveId: z.string().uuid() });
const kindSchema = z.enum(DIALOGUE_KINDS);

export async function registerAutonomyRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    "/api/v1/autonomy/settings",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => app.services.autonomy.settings(requestContext(request)),
  );

  route.patch(
    "/api/v1/autonomy/settings",
    {
      schema: {
        tags: ["autonomy"],
        body: z.object({
          enabled: z.boolean().optional(),
          paused: z.boolean().optional(),
          intervalMs: z.number().int().nonnegative().max(86_400_000).optional(),
          cooldownMs: z.number().int().nonnegative().max(86_400_000).optional(),
          maxActiveGoals: z.number().int().positive().max(8).optional(),
          maxInferenceRequests: z.number().int().nonnegative().max(12).optional(),
          maxDurationMs: z.number().int().positive().max(86_400_000).optional(),
          maxConversations: z.number().int().positive().max(20).optional(),
          maxConversationMessages: z.number().int().positive().max(40).optional(),
          maxConversationTokens: z.number().int().positive().max(100_000).optional(),
          maxConversationParticipants: z.number().int().min(2).max(12).optional(),
          conversationExecutionEnabled: z.boolean().optional(),
          maxConcurrentConversationTurns: z.number().int().min(1).max(4).optional(),
          contextTokenBudget: z.number().int().min(200).max(8_000).optional(),
          conversationSoftTokenBudget: z.number().int().min(1).max(200_000).optional(),
          conversationHardTokenCeiling: z.number().int().min(1).max(200_000).optional(),
          conversationCheckpointTurns: z.number().int().min(1).max(100).optional(),
        }),
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => app.services.autonomy.update(requestContext(request), request.body),
  );

  route.post(
    "/api/v1/autonomy/pause",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => app.services.autonomy.pause(requestContext(request)),
  );

  route.post(
    "/api/v1/autonomy/resume",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => app.services.autonomy.resume(requestContext(request)),
  );

  route.post(
    "/api/v1/autonomy/cycles",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      return app.services.autonomy.runCycle(requestContext(request), provider, inference.route);
    },
  );

  route.get(
    "/api/v1/autonomy/goals",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => ({ goals: await app.services.autonomy.goals(requestContext(request)) }),
  );

  route.get(
    "/api/v1/autonomy/cycles",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => ({ cycles: await app.services.autonomy.history(requestContext(request)) }),
  );

  route.get(
    "/api/v1/autonomy/summary",
    { schema: { tags: ["autonomy"], response: { 200: json, ...errorResponses } } },
    async (request) => app.services.autonomy.summary(requestContext(request)),
  );

  route.post(
    "/api/v1/autonomy/goals/:id/cancel",
    { schema: { tags: ["autonomy"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => ({ goal: await app.services.autonomy.cancel(requestContext(request), request.params.id) }),
  );

  route.get(
    "/api/v1/objectives/:objectiveId/subgoals",
    { schema: { tags: ["autonomy"], params: objectiveParams, response: { 200: json, ...errorResponses } } },
    async (request) => ({
      subgoals: await app.services.autonomy.subgoals(requestContext(request), request.params.objectiveId),
    }),
  );

  route.post(
    "/api/v1/objectives/:objectiveId/subgoals",
    {
      schema: {
        tags: ["autonomy"],
        params: objectiveParams,
        body: z.object({
          description: z.string().min(1).max(2000),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
        }),
        response: { 201: json, ...errorResponses },
      },
    },
    async (request, reply) => {
      const subgoal = await app.services.autonomy.createSubgoal(
        requestContext(request),
        request.params.objectiveId,
        request.body,
      );
      return reply.status(201).send({ subgoal });
    },
  );

  route.get(
    "/api/v1/department-conversations",
    { schema: { tags: ["dialogue"], response: { 200: json, ...errorResponses } } },
    async (request) => ({ conversations: await app.services.dialogue.list(requestContext(request)) }),
  );

  route.post(
    "/api/v1/department-conversations/route",
    {
      schema: {
        tags: ["dialogue"],
        body: z.object({
          task: z.string().trim().min(1).max(2000),
          objectiveId: z.string().uuid().nullable().optional(),
          maxParticipants: z.number().int().min(2).max(12).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
        }),
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const inferenceRoute = await routeWithDepartmentEndpoints(inference.route, app.database, inference.apiKey);
      const routing = await app.services.dialogue.routeDepartments(
        requestContext(request),
        provider,
        inferenceRoute,
        request.body,
      );
      return { routing };
    },
  );

  route.post(
    "/api/v1/department-conversations",
    {
      schema: {
        tags: ["dialogue"],
        body: z.union([
          z.object({
            routingMode: z.literal("hybrid"),
            task: z.string().trim().min(1).max(2000),
            topic: z.string().min(1).max(500).optional(),
            objectiveId: z.string().uuid().nullable().optional(),
            kind: kindSchema,
            instruction: z.string().min(1).max(2000),
            idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
            routingIdempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/).optional(),
          }),
          z.object({
            routingMode: z.literal("manual").optional(),
            recipientDepartmentId: z.string().uuid(),
            participantDepartmentIds: z.array(z.string().uuid()).max(10).optional(),
            topic: z.string().min(1).max(500),
            objectiveId: z.string().uuid().nullable().optional(),
            kind: kindSchema,
            instruction: z.string().min(1).max(2000),
            idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
          }),
        ]),
        response: { 201: json, ...errorResponses },
      },
    },
    async (request, reply) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const inferenceRoute = await routeWithDepartmentEndpoints(inference.route, app.database, inference.apiKey);
      if (request.body.routingMode === "hybrid") {
        const opened = await app.services.dialogue.openHybrid(
          requestContext(request),
          provider,
          inferenceRoute,
          request.body,
        );
        return reply.status(201).send(opened);
      }
      const turn = await app.services.dialogue.open(requestContext(request), provider, inferenceRoute, request.body);
      return reply.status(201).send({ turn });
    },
  );

  route.get(
    "/api/v1/department-conversations/:id",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => {
      const record = await app.services.dialogue.read(requestContext(request), request.params.id);
      return {
        ...record,
        lines: record.turns.map((turn) => `${turn.departmentSlug} (${turn.kind}): ${turn.body}`),
        exchanges: record.turns.map((turn) => ({
          from: turn.departmentSlug,
          to: turn.addressedDepartmentSlug ?? "group",
          kind: turn.kind,
          body: turn.body,
          messageId: turn.messageId,
          parentMessageId: turn.parentMessageId,
        })),
      };
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/turns",
    {
      schema: {
        tags: ["dialogue"],
        params: idParams,
        body: z.object({
          kind: kindSchema,
          instruction: z.string().min(1).max(2000),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
          parentMessageId: z.string().uuid().nullable().optional(),
          addressedDepartmentId: z.string().uuid().nullable().optional(),
        }),
        response: { 201: json, ...errorResponses },
      },
    },
    async (request, reply) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const turn = await app.services.dialogue.speak(
        requestContext(request),
        provider,
        inference.route,
        request.params.id,
        request.body,
      );
      return reply.status(201).send({ turn });
    },
  );

  route.get(
    "/api/v1/department-conversations/:id/speaker",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => app.services.dialogue.nextSpeaker(requestContext(request), request.params.id),
  );

  route.post(
    "/api/v1/department-conversations/:id/invitations",
    {
      schema: {
        tags: ["dialogue"],
        params: idParams,
        body: z.object({
          departmentId: z.string().uuid(),
          instruction: z.string().min(1).max(2000),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
        }),
        response: { 201: json, ...errorResponses },
      },
    },
    async (request, reply) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const turn = await app.services.dialogue.invite(
        requestContext(request),
        provider,
        inference.route,
        request.params.id,
        request.body,
      );
      return reply.status(201).send({ turn });
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/join-requests",
    {
      schema: {
        tags: ["dialogue"],
        params: idParams,
        body: z.object({
          targetDepartmentId: z.string().uuid(),
          justification: z.string().trim().min(1).max(2000),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
        }),
        response: { 201: json, ...errorResponses },
      },
    },
    async (request, reply) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const inferenceRoute = await routeWithDepartmentEndpoints(inference.route, app.database, inference.apiKey);
      const joinRequest = await app.services.joins.requestJoin(
        requestContext(request),
        provider,
        inferenceRoute,
        request.params.id,
        request.body,
      );
      return reply.status(201).send({ joinRequest });
    },
  );

  route.get(
    "/api/v1/department-conversations/:id/join-requests",
    {
      schema: {
        tags: ["dialogue"],
        params: idParams,
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => ({
      joinRequests: await app.services.joins.listJoinRequests(requestContext(request), request.params.id),
    }),
  );

  route.get(
    "/api/v1/department-conversations/:id/join-requests/:requestId",
    {
      schema: {
        tags: ["dialogue"],
        params: z.object({ id: z.string().uuid(), requestId: z.string().uuid() }),
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => {
      const joinRequest = await app.services.joins.getJoinRequest(requestContext(request), request.params.requestId);
      if (joinRequest.conversationId !== request.params.id) {
        throw new DomainError("NOT_FOUND", "DepartmentJoinRequest was not found", 404, {
          requestId: request.params.requestId,
        });
      }
      return { joinRequest };
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/accept",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => {
      await app.services.dialogue.accept(requestContext(request), request.params.id);
      return { accepted: true };
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/decline",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => {
      await app.services.dialogue.decline(requestContext(request), request.params.id);
      return { declined: true };
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/participants/:departmentId/remove",
    {
      schema: {
        tags: ["dialogue"],
        params: participantParams,
        body: z.object({ reason: z.string().min(1).max(500) }),
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => {
      await app.services.dialogue.remove(
        requestContext(request),
        request.params.id,
        request.params.departmentId,
        request.body.reason,
      );
      return { removed: true };
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/terminate",
    {
      schema: {
        tags: ["dialogue"],
        params: idParams,
        body: z.object({ reason: z.string().min(1).max(500) }),
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => ({
      conversation: await app.services.dialogue.terminate(requestContext(request), request.params.id, request.body.reason),
    }),
  );

  route.post(
    "/api/v1/department-conversations/:id/run",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => {
      const inference = app.services.inference;
      const provider = new OpenAICompatibleProvider({
        baseUrl: inference.baseUrl,
        apiKey: inference.apiKey,
        maxConcurrency: 1,
        transportRetries: 0,
      });
      const route = await routeWithDepartmentEndpoints(inference.route, app.database, inference.apiKey);
      return app.services.runner.run(requestContext(request), request.params.id, provider, route);
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/pause",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => {
      await app.services.runner.pause(requestContext(request), request.params.id);
      return { paused: true };
    },
  );

  route.post(
    "/api/v1/department-conversations/:id/resume",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => {
      await app.services.runner.resume(requestContext(request), request.params.id);
      return { resumed: true };
    },
  );

  route.get(
    "/api/v1/department-conversations/:id/runtime",
    { schema: { tags: ["dialogue"], params: idParams, response: { 200: json, ...errorResponses } } },
    async (request) => app.services.runner.status(requestContext(request), request.params.id),
  );

  route.post(
    "/api/v1/department-conversations/:id/search",
    {
      schema: {
        tags: ["dialogue"],
        params: idParams,
        body: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(8).optional() }),
        response: { 200: json, ...errorResponses },
      },
    },
    async (request) => app.services.dialogue.search(requestContext(request), request.params.id, request.body.query, request.body.limit ?? 5),
  );
}
