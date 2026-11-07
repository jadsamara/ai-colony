import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  evidenceAttemptListQuerySchema,
  evidenceCorrectionProposeSchema,
  evidenceCorrectionReviewSchema,
  evidenceCorrectionSchema,
  evidenceEligibilityUpdateSchema,
  inferenceAttemptSchema,
} from "@ai-colony/contracts";
import { errorResponses, requestContext } from "./common.js";

const idParams = z.object({ id: z.string().uuid() });

export async function registerTrainingEvidenceRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    "/api/v1/training/evidence/attempts",
    {
      schema: {
        tags: ["training-evidence"],
        querystring: evidenceAttemptListQuerySchema,
        response: {
          200: z.object({
            total: z.number().int().nonnegative(),
            limit: z.number().int().positive(),
            offset: z.number().int().nonnegative(),
            data: z.array(inferenceAttemptSchema),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => app.services.evidence.listAttempts(requestContext(request), request.query),
  );

  route.get(
    "/api/v1/training/evidence/attempts/:id",
    {
      schema: {
        tags: ["training-evidence"],
        params: idParams,
        querystring: z.object({
          includeRaw: z
            .union([z.literal("true"), z.literal("false"), z.boolean()])
            .optional()
            .transform((value) => value === true || value === "true"),
        }),
        response: {
          200: z.object({
            attempt: inferenceAttemptSchema,
            corrections: z.array(evidenceCorrectionSchema),
            eligibilityEvents: z.array(z.record(z.unknown())),
            provenance: z.object({
              knowledgeSystem: z.literal("separate"),
              trainingEligible: z.boolean(),
              eligibilityStatus: z.string(),
              note: z.string(),
            }),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const result = await app.services.evidence.getAttempt(
        requestContext(request),
        request.params.id,
        request.query.includeRaw === true,
      );
      return {
        ...result,
        corrections: result.corrections.map((row) => ({ ...row })),
        eligibilityEvents: result.eligibilityEvents.map((row) => ({ ...row })),
      };
    },
  );

  route.get(
    "/api/v1/training/evidence/stats",
    {
      schema: {
        tags: ["training-evidence"],
        querystring: evidenceAttemptListQuerySchema.pick({
          conversationId: true,
          departmentId: true,
          modelRegistryId: true,
          since: true,
          until: true,
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                failureClass: z.string().nullable(),
                acceptanceStatus: z.string(),
                count: z.number().int().nonnegative(),
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => app.services.evidence.failureStats(requestContext(request), request.query),
  );

  route.get(
    "/api/v1/training/evidence/conversations/:id/attempts",
    {
      schema: {
        tags: ["training-evidence"],
        params: idParams,
        querystring: evidenceAttemptListQuerySchema.omit({ conversationId: true }),
        response: {
          200: z.object({
            total: z.number().int().nonnegative(),
            limit: z.number().int().positive(),
            offset: z.number().int().nonnegative(),
            data: z.array(inferenceAttemptSchema),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) =>
      app.services.evidence.listAttempts(requestContext(request), {
        ...request.query,
        conversationId: request.params.id,
      }),
  );

  route.post(
    "/api/v1/training/evidence/attempts/:id/corrections",
    {
      schema: {
        tags: ["training-evidence"],
        params: idParams,
        body: evidenceCorrectionProposeSchema,
        response: { 201: z.object({ correction: evidenceCorrectionSchema }), ...errorResponses },
      },
    },
    async (request, reply) => {
      const correction = await app.services.evidence.proposeCorrection(requestContext(request), {
        attemptId: request.params.id,
        ...request.body,
      });
      return reply.status(201).send({ correction });
    },
  );

  route.post(
    "/api/v1/training/evidence/corrections/:id/review",
    {
      schema: {
        tags: ["training-evidence"],
        params: idParams,
        body: evidenceCorrectionReviewSchema,
        response: { 200: z.object({ correction: evidenceCorrectionSchema }), ...errorResponses },
      },
    },
    async (request) => ({
      correction: await app.services.evidence.reviewCorrection(requestContext(request), request.params.id, request.body),
    }),
  );

  route.post(
    "/api/v1/training/evidence/attempts/:id/eligibility",
    {
      schema: {
        tags: ["training-evidence"],
        params: idParams,
        body: evidenceEligibilityUpdateSchema,
        response: { 200: z.object({ attempt: inferenceAttemptSchema }), ...errorResponses },
      },
    },
    async (request) => ({
      attempt: await app.services.evidence.setEligibility(requestContext(request), request.params.id, request.body),
    }),
  );

  route.get(
    "/api/v1/training/evidence/capture-failures",
    {
      schema: {
        tags: ["training-evidence"],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
        response: { 200: z.object({ data: z.array(z.record(z.unknown())) }), ...errorResponses },
      },
    },
    async (request) => {
      const result = await app.services.evidence.listCaptureFailures(requestContext(request), request.query.limit);
      return { data: result.data.map((row) => ({ ...row })) };
    },
  );
}
