import {
  bindDedicatedEndpoints,
  dedicatedRoutingEnabled,
  readActivation,
  type InferenceRoute,
} from "@ai-colony/core";
import { listDedicatedInstances, type Database } from "@ai-colony/database";
import { OpenAICompatibleProvider } from "@ai-colony/inference";

export async function routeWithDepartmentEndpoints(
  route: InferenceRoute,
  database: Database | null,
  apiKey: string | null,
): Promise<InferenceRoute> {
  if (!database || !dedicatedRoutingEnabled(process.env, readActivation(process.env.COLONY_ACTIVATION_FILE ?? "deploy/state/dedicated-routing.json"))) {
    return route;
  }
  const instances = bindDedicatedEndpoints(await listDedicatedInstances(database), { resolve: resolveServingUrl });
  const providers = new Map<string, OpenAICompatibleProvider>();
  return {
    ...route,
    dedicatedRouting: {
      enabled: true,
      instances,
      providerFor(instanceId) {
        const instance = instances.find((item) => item.instanceId === instanceId && item.status === "ready");
        if (!instance) {
          return null;
        }
        const existing = providers.get(instance.instanceId);
        if (existing) {
          return existing;
        }
        const provider = new OpenAICompatibleProvider({
          baseUrl: instance.normalizedEndpoint,
          apiKey,
          maxConcurrency: 1,
          transportRetries: 0,
        });
        providers.set(instance.instanceId, provider);
        return provider;
      },
    },
  };
}

function resolveServingUrl(endpointReference: string): string {
  if (process.env.COLONY_SERVING_DIRECTORY) {
    const directory = JSON.parse(process.env.COLONY_SERVING_DIRECTORY) as Record<string, string>;
    const configured = directory[endpointReference];
    if (!configured) {
      throw new Error(`Trusted directory has no entry for ${endpointReference}`);
    }
    return configured;
  }
  const slug = endpointReference.slice("serving://".length);
  return process.env.COLONY_MODE === "mock" ? `http://mock-${slug}:8080` : `http://ollama-${slug}:11434`;
}
