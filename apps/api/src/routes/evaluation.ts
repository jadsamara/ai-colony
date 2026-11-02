import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ id: z.string().uuid() });
const json = z.any();

export async function registerEvaluationRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post("/api/v1/evaluations/suites", {
    schema: { tags: ["evaluation"], body: z.object({ slug: z.string().min(3).max(64), name: z.string().min(1).max(120) }).strict(), response: { 201: json, ...errorResponses } },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.createSuite(requestContext(request), request.body)));

  route.post("/api/v1/evaluations/suites/:id/versions", {
    schema: {
      tags: ["evaluation"],
      params: idParams,
      body: z.object({
        description: z.string().min(1).max(500),
        domain: z.enum(["arithmetic", "structured", "reasoning", "retrieval", "memory", "regression"]),
        source: z.string().min(1).max(200),
        license: z.string().min(1).max(120),
        protocol: z.string().min(1).max(500),
        sealed: z.boolean(),
        items: z.array(z.object({ prompt: z.string().min(1).max(500), expected: z.string().min(1).max(80) }).strict()).min(1).max(64),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.addVersion(requestContext(request), request.params.id, request.body)));

  route.post("/api/v1/evaluations/versions/:id/publish", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.publishVersion(requestContext(request), request.params.id));

  route.get("/api/v1/evaluations/suites", {
    schema: { tags: ["evaluation"], response: { 200: z.object({ data: z.array(json) }), ...errorResponses } },
  }, async (request) => app.services.evaluation.listSuites(requestContext(request)));

  route.get("/api/v1/evaluations/versions/:id", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.getVersion(requestContext(request), request.params.id));

  route.post("/api/v1/evaluations/compare", {
    schema: {
      tags: ["evaluation"],
      body: z.object({
        baseline: z.record(z.string(), z.unknown()),
        candidate: z.record(z.string(), z.unknown()),
        items: z.array(z.object({
          itemId: z.string().min(1).max(80),
          contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
          baselineCorrect: z.boolean().nullable(),
          candidateCorrect: z.boolean().nullable(),
          baselineValid: z.boolean(),
          candidateValid: z.boolean(),
        }).strict()).max(2000).optional(),
      }).strict(),
      response: { 200: json, ...errorResponses },
    },
  }, async (request) => app.services.evaluation.compare(requestContext(request), request.body));

  route.post("/api/v1/evaluations/runs", {
    schema: {
      tags: ["evaluation"],
      body: z.object({
        versionId: z.string().uuid(),
        candidateId: z.string().uuid(),
        source: z.enum(["live", "historical"]),
        baselineOutputs: z.array(z.string().max(500)).max(64).optional(),
        candidateOutputs: z.array(z.string().max(500)).max(64).optional(),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.run(requestContext(request), request.body)));

  route.get("/api/v1/evaluations/runs/:id", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.getReport(requestContext(request), request.params.id));

  route.post("/api/v1/evaluations/runs/:id/gate", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.decide(requestContext(request), request.params.id));

  route.post("/api/v1/models/candidates/:id/quarantine", {
    schema: { tags: ["evaluation"], params: idParams, body: z.object({ reason: z.string().min(1).max(500) }).strict(), response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.quarantine(requestContext(request), request.params.id, request.body.reason));

  route.post("/api/v1/models/candidates/:id/revoke", {
    schema: { tags: ["evaluation"], params: idParams, body: z.object({ reason: z.string().min(1).max(500) }).strict(), response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.revoke(requestContext(request), request.params.id, request.body.reason));

  route.get("/api/v1/models/experimental-routes", {
    schema: { tags: ["evaluation"], response: { 200: z.object({ data: z.array(json) }), ...errorResponses } },
  }, async (request) => app.services.evaluation.listRoutes(requestContext(request)));

  route.post("/api/v1/models/experimental-routes", {
    schema: {
      tags: ["evaluation"],
      body: z.object({
        slug: z.string().min(3).max(64),
        kind: z.enum(["baseline", "candidate"]),
        candidateId: z.string().uuid().optional(),
        trainableModelId: z.string().uuid().optional(),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.changeRoute(requestContext(request), request.body)));

  route.post("/api/v1/models/experimental-routes/:id/rollback-requests", {
    schema: {
      tags: ["evaluation"],
      params: idParams,
      body: z.object({ toVersion: z.number().int().positive(), reason: z.string().min(1).max(500) }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.requestRollback(requestContext(request), request.params.id, request.body.toVersion, request.body.reason)));

  route.post("/api/v1/models/rollback-requests/:id/approve", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.approveRollback(requestContext(request), request.params.id));

  route.post("/api/v1/models/rollback-requests/:id/execute", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.executeRollback(requestContext(request), request.params.id));

  route.post("/api/v1/memory/retention-policies", {
    schema: {
      tags: ["evaluation"],
      body: z.object({
        name: z.string().min(1).max(80),
        scope: z.enum(["agent", "department", "colony"]).optional(),
        provenance: z.enum(["model_generated", "system_observed", "user_provided", "externally_verified"]).optional(),
        maxAgeDays: z.number().int().positive().max(3650).optional(),
      }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.createRetention(requestContext(request), request.body)));

  route.post("/api/v1/memory/retention-policies/:id/preview", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.previewRetention(requestContext(request), request.params.id));

  route.post("/api/v1/memory/forgetting-requests", {
    schema: {
      tags: ["evaluation"],
      body: z.object({ memoryId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128) }).strict(),
      response: { 201: json, ...errorResponses },
    },
  }, async (request, reply) => reply.status(201).send(await app.services.evaluation.requestForgetting(requestContext(request), request.body.memoryId, request.body.idempotencyKey)));

  route.get("/api/v1/memory/forgetting-requests/:id", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.getForgetting(requestContext(request), request.params.id));

  route.post("/api/v1/memory/forgetting-requests/:id/approve", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.approveForgetting(requestContext(request), request.params.id));

  route.post("/api/v1/memory/forgetting-requests/:id/execute", {
    schema: { tags: ["evaluation"], params: idParams, response: { 200: json, ...errorResponses } },
  }, async (request) => app.services.evaluation.executeForgetting(requestContext(request), request.params.id));
}
