import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LiveModelHealth } from "@ai-colony/contracts";
import { artifactPresence, describeModelHealth } from "@ai-colony/core";
import { OllamaStatusClient } from "@ai-colony/inference";
import { requestContext } from "./common.js";

const clients = new Map<string, OllamaStatusClient>();

function clientFor(app: FastifyInstance): OllamaStatusClient {
  const inference = app.services.inference;
  const existing = clients.get(inference.baseUrl);
  if (existing) {
    return existing;
  }
  const created = new OllamaStatusClient({
    baseUrl: inference.baseUrl,
    timeoutMs: inference.probeTimeoutMs,
    freshnessMs: inference.probeFreshnessMs,
    minIntervalMs: inference.probeMinIntervalMs,
  });
  clients.set(inference.baseUrl, created);
  return created;
}

export async function currentModelHealth(
  app: FastifyInstance,
  request: FastifyRequest,
  models: Array<{
    modelId: string;
    displayName: string;
    runtimeStatus: string;
    expectedAlias: string | null;
    loadedModelId: string | null;
    endpointUrl: string | null;
    lastError: string | null;
    probedAt: string | null;
  }>,
): Promise<LiveModelHealth> {
  const inference = app.services.inference;
  const context = requestContext(request);
  const latest = await app.services.objectives.latestCompletedInferenceAt(context);
  const observation = await clientFor(app).inspect();
  const persisted = models.find((model) => model.modelId === inference.primaryModelId) ?? null;
  const alias = inference.route.alias;
  return describeModelHealth({
    alias,
    registered: models.some((model) => model.modelId === inference.primaryModelId),
    artifacts: artifactPresence(alias, homedir(), existsSync),
    persisted,
    observation,
    lastSuccessfulInferenceAt: latest,
    now: Date.now(),
    freshnessMs: inference.probeFreshnessMs,
  });
}
