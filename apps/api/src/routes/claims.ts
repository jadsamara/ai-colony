import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  conversationClaimDetailResponseSchema,
  conversationClaimListResponseSchema,
  conversationVerificationListResponseSchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ id: z.string().uuid() });

export async function registerClaimRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    "/api/v1/department-conversations/:id/claims",
    {
      schema: {
        tags: ["claims"],
        params: idParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        response: { 200: conversationClaimListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const claims = await app.services.claims.listClaims(
        requestContext(request),
        request.params.id,
        request.query.limit ?? 100,
      );
      return { conversationId: request.params.id, claims };
    },
  );

  route.get(
    "/api/v1/department-conversations/:id/claim-verifications",
    {
      schema: {
        tags: ["claims"],
        params: idParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        response: { 200: conversationVerificationListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const verifications = await app.services.claims.listVerifications(
        requestContext(request),
        request.params.id,
        request.query.limit ?? 100,
      );
      return { conversationId: request.params.id, verifications };
    },
  );

  route.get(
    "/api/v1/conversation-claims/:id",
    {
      schema: {
        tags: ["claims"],
        params: idParams,
        response: { 200: conversationClaimDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.claims.getClaim(requestContext(request), request.params.id),
  );
}
