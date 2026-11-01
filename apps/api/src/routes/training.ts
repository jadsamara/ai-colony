import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  candidateSchema,
  evaluationSchema,
  experimentalInferenceResponseSchema,
  experimentalInferenceSchema,
  promotionRequestSchema,
  registryResponseSchema,
  trainableCheckpointRegisterSchema,
  trainableCheckpointSchema,
  trainingArtifactSchema,
  trainingDatasetCreateSchema,
  trainingDatasetSchema,
  trainingDecisionSchema,
  trainingEvaluateSchema,
  trainingHealthSchema,
  trainingMetricSchema,
  trainingReproduceSchema,
  trainingRunCreateSchema,
  trainingRunSchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ id: z.string().uuid() });

export async function registerTrainingRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get("/api/v1/models/registry", { schema: { tags: ["training"], response: { 200: registryResponseSchema, ...errorResponses } } }, async (request) =>
    app.services.training.registry(requestContext(request)),
  );

  route.post("/api/v1/models/checkpoints", { schema: { tags: ["training"], body: trainableCheckpointRegisterSchema, response: { 201: z.object({ checkpoint: trainableCheckpointSchema }), ...errorResponses } } }, async (request, reply) => {
    const checkpoint = await app.services.training.registerCheckpoint(requestContext(request), request.body);
    return reply.status(201).send({ checkpoint });
  });

  route.get("/api/v1/models/candidates", { schema: { tags: ["training"], response: { 200: z.object({ data: z.array(candidateSchema) }), ...errorResponses } } }, async (request) =>
    app.services.training.listCandidates(requestContext(request)),
  );

  route.get("/api/v1/models/candidates/:id", { schema: { tags: ["training"], params: idParams, response: { 200: z.object({ candidate: candidateSchema, evaluation: evaluationSchema.nullable() }), ...errorResponses } } }, async (request) =>
    app.services.training.getCandidate(requestContext(request), request.params.id),
  );

  route.post("/api/v1/models/candidates/:id/promotion-requests", { schema: { tags: ["training"], params: idParams, body: promotionRequestSchema, response: { 201: z.object({ status: z.literal("proposed") }), ...errorResponses } } }, async (request, reply) => {
    const result = await app.services.training.requestPromotion(requestContext(request), request.params.id, request.body.reason);
    return reply.status(201).send(result);
  });

  route.post("/api/v1/models/candidates/:id/promote", { schema: { tags: ["training"], params: idParams, body: promotionRequestSchema, response: { 200: candidateSchema, ...errorResponses } } }, async (request) =>
    app.services.training.promote(requestContext(request), request.params.id, request.body.reason),
  );

  route.post("/api/v1/models/experimental-inference", { schema: { tags: ["training"], body: experimentalInferenceSchema, response: { 200: experimentalInferenceResponseSchema, ...errorResponses } } }, async (request) =>
    app.services.training.experimentalInfer(requestContext(request), request.body.candidateId, request.body.prompt),
  );

  route.post("/api/v1/training/datasets", { schema: { tags: ["training"], body: trainingDatasetCreateSchema, response: { 201: z.object({ dataset: trainingDatasetSchema }), ...errorResponses } } }, async (request, reply) => {
    const dataset = await app.services.training.createDataset(requestContext(request), request.body);
    return reply.status(201).send({ dataset });
  });

  route.get("/api/v1/training/datasets", { schema: { tags: ["training"], response: { 200: z.object({ data: z.array(trainingDatasetSchema) }), ...errorResponses } } }, async (request) =>
    app.services.training.listDatasets(requestContext(request)),
  );

  route.get("/api/v1/training/datasets/:id", { schema: { tags: ["training"], params: idParams, response: { 200: z.object({ dataset: trainingDatasetSchema }), ...errorResponses } } }, async (request) => ({
    dataset: await app.services.training.getDataset(requestContext(request), request.params.id),
  }));

  route.post("/api/v1/training/runs", { schema: { tags: ["training"], body: trainingRunCreateSchema, response: { 201: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request, reply) => {
    const run = await app.services.training.proposeRun(requestContext(request), request.body);
    return reply.status(201).send({ run });
  });

  route.get("/api/v1/training/runs", { schema: { tags: ["training"], response: { 200: z.object({ data: z.array(trainingRunSchema) }), ...errorResponses } } }, async (request) =>
    app.services.training.listRuns(requestContext(request)),
  );

  route.get("/api/v1/training/health", { schema: { tags: ["training"], response: { 200: trainingHealthSchema, ...errorResponses } } }, async (request) =>
    app.services.training.health(requestContext(request)),
  );

  route.get("/api/v1/training/runs/:id", { schema: { tags: ["training"], params: idParams, response: { 200: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request) => ({
    run: await app.services.training.getRun(requestContext(request), request.params.id),
  }));

  route.post("/api/v1/training/runs/:id/approve", { schema: { tags: ["training"], params: idParams, body: trainingDecisionSchema, response: { 200: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request) => ({
    run: await app.services.training.approve(requestContext(request), request.params.id),
  }));

  route.post("/api/v1/training/runs/:id/execute", { schema: { tags: ["training"], params: idParams, body: trainingDecisionSchema, response: { 200: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request) => ({
    run: await app.services.training.execute(requestContext(request), request.params.id),
  }));

  route.post("/api/v1/training/runs/:id/cancel", { schema: { tags: ["training"], params: idParams, body: trainingDecisionSchema, response: { 200: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request) => ({
    run: await app.services.training.cancel(requestContext(request), request.params.id),
  }));

  route.post("/api/v1/training/runs/:id/retry", { schema: { tags: ["training"], params: idParams, body: trainingDecisionSchema, response: { 200: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request) => ({
    run: await app.services.training.retry(requestContext(request), request.params.id),
  }));

  route.post("/api/v1/training/runs/:id/reproduce", { schema: { tags: ["training"], params: idParams, body: trainingReproduceSchema, response: { 201: z.object({ run: trainingRunSchema }), ...errorResponses } } }, async (request, reply) => {
    const run = await app.services.training.reproduce(requestContext(request), request.params.id, request.body.idempotencyKey);
    return reply.status(201).send({ run });
  });

  route.get("/api/v1/training/runs/:id/metrics", { schema: { tags: ["training"], params: idParams, response: { 200: z.object({ data: z.array(trainingMetricSchema) }), ...errorResponses } } }, async (request) =>
    app.services.training.metrics(requestContext(request), request.params.id),
  );

  route.get("/api/v1/training/runs/:id/artifacts", { schema: { tags: ["training"], params: idParams, response: { 200: z.object({ data: z.array(trainingArtifactSchema) }), ...errorResponses } } }, async (request) =>
    app.services.training.artifacts(requestContext(request), request.params.id),
  );

  route.post("/api/v1/training/runs/:id/evaluate", { schema: { tags: ["training"], params: idParams, body: trainingEvaluateSchema, response: { 200: evaluationSchema, ...errorResponses } } }, async (request) =>
    app.services.training.evaluate(requestContext(request), request.params.id),
  );
}
