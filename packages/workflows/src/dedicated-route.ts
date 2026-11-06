import {
  bindDedicatedEndpoints,
  dedicatedRoutingEnabled,
  probeServingEndpoint,
  readActivation,
  type DedicatedServingInstance,
  type InferenceRoute,
} from "@ai-colony/core";
import { listActiveDedicatedInstances, type Database } from "@ai-colony/database";
import { OpenAICompatibleProvider } from "@ai-colony/inference";

export function assertDepartmentEndpoint(slug: string | null, baseUrl: string): void {
  if (!slug) {
    return;
  }
  const host = new URL(baseUrl).hostname;
  if (host !== `ollama-${slug}` && host !== `mock-${slug}`) {
    throw new Error(`Refusing inference host ${host} for department ${slug}`);
  }
}

export function resolveServingUrl(env: NodeJS.ProcessEnv, endpointReference: string): string {
  if (env.COLONY_SERVING_DIRECTORY) {
    const directory = JSON.parse(env.COLONY_SERVING_DIRECTORY) as Record<string, string>;
    const configured = directory[endpointReference];
    if (!configured) {
      throw new Error(`Trusted directory has no entry for ${endpointReference}`);
    }
    return configured;
  }
  const slug = endpointReference.slice("serving://".length);
  return env.COLONY_MODE === "mock" ? `http://mock-${slug}:8080` : `http://ollama-${slug}:11434`;
}

export async function applyWorkerDedicatedRouting(
  route: InferenceRoute,
  db: Database,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const record = readActivation(env.COLONY_ACTIVATION_FILE ?? "deploy/state/dedicated-routing.json");
  if (!dedicatedRoutingEnabled(env, record)) {
    route.dedicatedRouting = undefined;
    return;
  }
  const stored = await listActiveDedicatedInstances(db);
  const bound = bindDedicatedEndpoints(stored, {
    resolve: (reference) => resolveServingUrl(env, reference),
  });
  const probed: DedicatedServingInstance[] = [];
  for (const instance of bound) {
    const live = await probeServingEndpoint(instance.normalizedEndpoint, 2_000);
    probed.push({ ...instance, status: live ? "ready" : "unavailable" });
  }
  route.dedicatedRouting = {
    enabled: true,
    instances: probed,
    providerFor(instanceId) {
      const instance = probed.find((item) => item.instanceId === instanceId);
      if (!instance || instance.status !== "ready") {
        return null;
      }
      return new OpenAICompatibleProvider({
        baseUrl: instance.normalizedEndpoint,
        apiKey: null,
        maxConcurrency: 1,
        transportRetries: 0,
      });
    },
  };
}
