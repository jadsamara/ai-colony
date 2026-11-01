import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  approvalDecisionSchema,
  approvalListQuerySchema,
  approvalListResponseSchema,
  approvalRequestSchema,
  approvalResponseSchema,
  auditListQuerySchema,
  auditListResponseSchema,
  meResponseSchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

export async function registerGovernanceRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    "/api/v1/me",
    {
      schema: {
        tags: ["identity"],
        response: { 200: meResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({ principal: requestContext(request).actor }),
  );

  route.post(
    "/api/v1/approvals",
    {
      schema: {
        tags: ["approvals"],
        body: approvalRequestSchema,
        response: { 201: approvalResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = await app.services.approvals.request(requestContext(request), request.body);
      return reply.status(201).send(result);
    },
  );

  route.get(
    "/api/v1/approvals",
    {
      schema: {
        tags: ["approvals"],
        querystring: approvalListQuerySchema,
        response: { 200: approvalListResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.approvals.list(requestContext(request), request.query),
  );

  route.get(
    "/api/v1/approvals/:id",
    {
      schema: {
        tags: ["approvals"],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ approval: approvalResponseSchema.shape.approval }),
          ...errorResponses,
        },
      },
    },
    async (request) => ({
      approval: await app.services.approvals.get(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/approvals/:id/decide",
    {
      schema: {
        tags: ["approvals"],
        params: z.object({ id: z.string().uuid() }),
        body: approvalDecisionSchema,
        response: { 200: approvalResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.approvals.decide(requestContext(request), request.params.id, request.body),
  );

  route.get(
    "/api/v1/audit-events",
    {
      schema: {
        tags: ["audit"],
        querystring: auditListQuerySchema,
        response: { 200: auditListResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.audit.list(requestContext(request), request.query),
  );
}
