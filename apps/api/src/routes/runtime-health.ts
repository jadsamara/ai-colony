import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { colonyHealthSchema } from "@ai-colony/contracts";
import {
  DISPATCHER_PROCESS,
  TRAINING_PROCESS,
  WORKER_PROCESS,
  buildRuntimeReport,
  commandLines,
  processSeen,
} from "@ai-colony/core";
import { errorResponses, requestContext } from "./common.js";
import { currentModelHealth } from "./live-model.js";

export async function registerRuntimeHealthRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.get(
    "/api/v1/runtime/health",
    {
      schema: {
        tags: ["health"],
        response: { 200: colonyHealthSchema, ...errorResponses },
      },
    },
    async (request) => {
      const evidence = await app.services.objectives.runtimeEvidence(requestContext(request));
      const lines = await commandLines();
      const model = await currentModelHealth(app, request, evidence.models);
      return buildRuntimeReport({
        checkedAt: new Date().toISOString(),
        postgres: {
          connected: true,
          database: null,
          dataDirectory: null,
          session: "application",
        },
        rabbitReachable: null,
        apiListening: true,
        workers: {
          heartbeats: evidence.heartbeats,
          processSeen: processSeen(lines, WORKER_PROCESS),
          now: Date.now(),
          staleAfterMs: app.services.inference.staleAfterMs,
        },
        dispatcher: {
          processSeen: processSeen(lines, DISPATCHER_PROCESS),
          pending: evidence.metrics.outbox.pending,
        },
        registry: {
          registered: evidence.models.map((item) => item.displayName),
          installed: model.evidence.installed_models,
        },
        training: {
          provider: process.env.TRAINING_PROVIDER ?? "scripted",
          processSeen: processSeen(lines, TRAINING_PROCESS),
          lastExperimentAt: null,
        },
        model,
        outbox: {
          pending: evidence.metrics.outbox.pending,
          publishing: evidence.metrics.outbox.publishing,
          published: evidence.metrics.outbox.published,
          failed: evidence.metrics.outbox.failed,
          oldest_pending_age_ms: evidence.metrics.oldestPendingAgeMs,
          delivery_guarantee: evidence.metrics.deliveryGuarantee,
        },
      });
    },
  );
}
