import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentListResponseSchema,
  departmentCreateSchema,
  departmentFailSchema,
  departmentHierarchyResponseSchema,
  departmentListQuerySchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  departmentUpdateSchema,
  paginationQuerySchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

export async function registerDepartmentRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    "/api/v1/departments",
    {
      schema: {
        tags: ["departments"],
        body: departmentCreateSchema,
        response: { 201: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const department = await app.services.departments.create(
        requestContext(request),
        request.body,
      );
      return reply.status(201).send({ department });
    },
  );

  route.get(
    "/api/v1/departments",
    {
      schema: {
        tags: ["departments"],
        querystring: departmentListQuerySchema,
        response: { 200: departmentListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const page = await app.services.departments.list(request.query);
      return page;
    },
  );

  route.get(
    "/api/v1/departments/:id",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({ department: await app.services.departments.get(request.params.id) }),
  );

  route.patch(
    "/api/v1/departments/:id",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        body: departmentUpdateSchema,
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      department: await app.services.departments.update(
        requestContext(request),
        request.params.id,
        request.body,
      ),
    }),
  );

  route.get(
    "/api/v1/departments/:id/hierarchy",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: departmentHierarchyResponseSchema, ...errorResponses },
      },
    },
    async (request) => app.services.departments.hierarchy(request.params.id),
  );

  route.get(
    "/api/v1/departments/:id/agents",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        querystring: paginationQuerySchema,
        response: { 200: agentListResponseSchema, ...errorResponses },
      },
    },
    async (request) =>
      app.services.departments.listAgents(request.params.id, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
  );

  route.post(
    "/api/v1/departments/:id/activate",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      department: await app.services.departments.activate(
        requestContext(request),
        request.params.id,
      ),
    }),
  );

  route.post(
    "/api/v1/departments/:id/pause",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      department: await app.services.departments.pause(requestContext(request), request.params.id),
    }),
  );

  route.post(
    "/api/v1/departments/:id/deprecate",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      department: await app.services.departments.deprecate(
        requestContext(request),
        request.params.id,
      ),
    }),
  );

  route.post(
    "/api/v1/departments/:id/fail",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        body: departmentFailSchema,
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      department: await app.services.departments.fail(
        requestContext(request),
        request.params.id,
        request.body.reason,
      ),
    }),
  );

  route.post(
    "/api/v1/departments/:id/archive",
    {
      schema: {
        tags: ["departments"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: departmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => ({
      department: await app.services.departments.archive(
        requestContext(request),
        request.params.id,
      ),
    }),
  );
}
