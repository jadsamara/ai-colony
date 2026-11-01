import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  modelListQuerySchema,
  modelListResponseSchema,
  modelRegisterSchema,
  modelResponseSchema,
  modelStatusUpdateSchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

export async function registerModelRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    "/api/v1/models",
    {
      schema: {
        tags: ["models"],
        body: modelRegisterSchema,
        response: { 201: modelResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const model = await app.services.models.register(requestContext(request), request.body);
      return reply.status(201).send({ model });
    },
  );

  route.get(
    "/api/v1/models",
    {
      schema: {
        tags: ["models"],
        querystring: modelListQuerySchema,
        response: { 200: modelListResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.models.list(request.query),
  );

  route.get(
    "/api/v1/models/:id",
    {
      schema: {
        tags: ["models"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: modelResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({ model: await app.services.models.get(request.params.id) }),
  );

  route.post(
    "/api/v1/models/:id/versions",
    {
      schema: {
        tags: ["models"],
        params: z.object({ id: z.string().uuid() }),
        body: modelRegisterSchema,
        response: { 201: modelResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const model = await app.services.models.registerVersion(
        requestContext(request),
        request.params.id,
        request.body,
      );
      return reply.status(201).send({ model });
    },
  );

  route.patch(
    "/api/v1/models/:id/status",
    {
      schema: {
        tags: ["models"],
        params: z.object({ id: z.string().uuid() }),
        body: modelStatusUpdateSchema,
        response: { 200: modelResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      model: await app.services.models.updateStatus(
        requestContext(request),
        request.params.id,
        request.body.status,
      ),
    }),
  );
}
