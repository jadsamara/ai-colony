import type { FastifyRequest } from "fastify";
import { errorResponseSchema } from "@ai-colony/contracts";
import { DomainError, type RequestContext } from "@ai-colony/core";

export const errorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  413: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
};

export function requestContext(request: FastifyRequest): RequestContext {
  if (!request.actor) {
    throw new DomainError("UNAUTHENTICATED", "Authentication is required", 401);
  }
  return { actor: request.actor, correlationId: request.correlationId };
}
