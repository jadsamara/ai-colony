import { DomainError } from "../errors/domain-error.js";
import type { DedicatedServingInstance } from "./types.js";
import type { DepartmentModelClient, ModelTurn } from "./runtime.js";

export function httpDepartmentClient(instance: DedicatedServingInstance): DepartmentModelClient {
  return {
    async complete(input): Promise<ModelTurn> {
      if (input.instance.instanceId !== instance.instanceId || input.instance.normalizedEndpoint !== instance.normalizedEndpoint) {
        throw new DomainError("ENDPOINT_OVERRIDE_DENIED", "Task cannot select another serving endpoint", 403);
      }
      if (!instance.normalizedEndpoint.startsWith("http://") && !instance.normalizedEndpoint.startsWith("https://")) {
        throw new DomainError("SERVING_INSTANCE_UNAVAILABLE", "Serving endpoint is not bound", 503);
      }
      let response: Response;
      try {
        response = await fetch(`${instance.normalizedEndpoint}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: input.instance.modelVersion,
            messages: [
              { role: "system", content: input.instructions },
              { role: "user", content: input.objective },
            ],
          }),
        });
      } catch {
        throw new DomainError("SERVING_INSTANCE_UNAVAILABLE", "Dedicated serving instance did not respond", 503);
      }
      if (!response.ok) {
        throw new DomainError("SERVING_INSTANCE_UNAVAILABLE", "Dedicated serving instance refused the request", 503);
      }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
      return {
        text: payload.choices?.[0]?.message?.content ?? "",
        tokens: payload.usage?.total_tokens ?? 0,
      };
    },
  };
}
