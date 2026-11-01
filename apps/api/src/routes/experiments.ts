import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponses, requestContext } from "./common.js";

const experimentBody = z.object({
  idempotencyKey: z.string().min(8).max(200),
  methodId: z.string().min(1).max(80),
  modelId: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(80),
  adapterSha256: z.string().length(64).nullable(),
  problem: z.string().min(1).max(500),
  datasetSize: z.number().int().positive(),
  learningRate: z.number().positive(),
  steps: z.number().int().nonnegative(),
  target: z.enum(["answer", "structured"]),
  seed: z.number().int(),
  devAccuracy: z.number().nullable(),
  baselineAccuracy: z.number().nullable(),
  sealedAccuracy: z.number().nullable(),
  retentionOk: z.boolean().nullable(),
  failureClass: z.string().max(80).nullable(),
  recommendation: z.string().min(1).max(500),
  evidencePath: z.string().min(1).max(300),
});

const stopBody = experimentBody.extend({
  peakMemoryBytes: z.number().int().nullable(),
  maxMemoryBytes: z.number().int().positive().optional(),
  lossFinite: z.boolean(),
  datasetValid: z.boolean(),
  modelCompatible: z.boolean(),
  evaluationPresent: z.boolean(),
});

const planBody = z.object({
  problem: z.string().min(1).max(500),
  baseAccuracy: z.number().nullable(),
  budgetMaxSteps: z.number().int().nonnegative(),
});

export async function registerExperimentRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const ok = { 200: z.any(), ...errorResponses };
  const created = { 201: z.any(), ...errorResponses };
  route.get("/api/v1/training/methods", { schema: { tags: ["training"], response: ok } }, async (request) => app.services.experiments.listMethods(requestContext(request)));
  route.get("/api/v1/training/experiments", { schema: { tags: ["training"], response: ok } }, async (request) => ({ data: await app.services.experiments.history(requestContext(request)) }));
  route.post("/api/v1/training/experiments", { schema: { tags: ["training"], body: experimentBody, response: created } }, async (request, reply) => {
    const result = await app.services.experiments.record(requestContext(request), request.body);
    return reply.status(201).send(result);
  });
  route.post("/api/v1/training/experiments/plan", { schema: { tags: ["training"], body: planBody, response: ok } }, async (request) => app.services.experiments.plan(requestContext(request), request.body));
  route.post("/api/v1/training/experiments/stop", { schema: { tags: ["training"], body: stopBody, response: ok } }, async (request) => app.services.experiments.stop(requestContext(request), request.body));
}
