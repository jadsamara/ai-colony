import { InferenceError, type InferenceProvider } from "../inference/provider.js";
import type { InferenceRoute } from "../objectives/objective-service.js";

export interface ConversationInferenceSelection {
  provider: InferenceProvider;
  departmentSlug: string;
  model: string;
  endpoint: string | null;
  metadata: string;
}

export function selectConversationInference(input: {
  departmentId: string;
  departmentSlug: string;
  shared: InferenceProvider;
  route: Pick<InferenceRoute, "alias" | "dedicatedRouting">;
}): ConversationInferenceSelection {
  const routing = input.route.dedicatedRouting;
  if (!routing?.enabled) {
    return selection(input.shared, input.departmentSlug, input.route.alias, null);
  }
  const instance = routing.instances.find((item) =>
    item.departmentId === input.departmentId && item.status === "ready" && item.deploymentMode === "dedicated");
  if (!instance) {
    throw new InferenceError("unavailable", `No dedicated endpoint for ${input.departmentSlug}`, true);
  }
  assertDepartmentHost(input.departmentSlug, instance.normalizedEndpoint);
  const bound = routing.providerFor?.(instance.instanceId) ?? null;
  if (!bound) {
    throw new InferenceError("unavailable", `Dedicated routing refused the shared inference route for ${input.departmentSlug}`, true);
  }
  return selection(bound, input.departmentSlug, instance.modelVersion, instance.normalizedEndpoint);
}

export function assertDepartmentHost(slug: string, endpoint: string): void {
  const url = new URL(endpoint);
  if (url.username || url.password) {
    throw new Error(`Refusing inference host with credentials for department ${slug}`);
  }
  if (url.hostname !== `ollama-${slug}` && url.hostname !== `mock-${slug}`) {
    throw new Error(`Refusing inference host ${url.hostname} for department ${slug}`);
  }
}

export function logConversationInference(metadata: string): void {
  console.info(`[conversation-inference] ${metadata}`);
}

function selection(provider: InferenceProvider, departmentSlug: string, model: string, endpoint: string | null): ConversationInferenceSelection {
  const published = endpoint ? publicOrigin(endpoint) : "shared";
  const metadata = `department=${departmentSlug} model=${model.slice(0, 80)} endpoint=${published}`;
  return { provider, departmentSlug, model, endpoint, metadata };
}

function publicOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}
