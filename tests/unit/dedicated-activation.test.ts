import { describe, expect, it } from "vitest";
import { selectConversationInference, type DedicatedServingInstance, type InferenceProvider, type InferenceRoute } from "@ai-colony/core";
import { activationReadiness } from "@ai-colony/database";

const route: InferenceRoute = {
  memoryProfile: "shared",
  alias: "qwen3-8b",
  operationalAlias: null,
  temperature: 0,
  maxOutputTokens: 256,
  timeoutMs: 1000,
  rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
  globalConcurrency: 2,
  departmentConcurrency: 1,
};

describe("dedicated activation", () => {
  it("activates when every active instance is ready and ignores an archived instance", () => {
    const active = Array.from({ length: 12 }, (_, index) => `active-${index}`);
    const archived = "00000000-0000-4000-8000-00000000031c";
    expect(activationReadiness(active, active)).toEqual({ ok: true, ready: 12, required: 12 });
    expect(activationReadiness([...active, archived], active)).toEqual({ ok: false, ready: 12, required: 13 });
    expect(activationReadiness(active, active.slice(1)).ok).toBe(false);
  });

  it("fails closed for an active department whose endpoint is unavailable", async () => {
    const shared = fakeProvider();
    const science = fakeProvider();
    expect(() => selectConversationInference({
      departmentId: "math-id",
      departmentSlug: "math",
      shared: shared.provider,
      route: {
        ...route,
        dedicatedRouting: {
          enabled: true,
          instances: [
            endpoint("math", "math-id", "http://ollama-math:11434", "unavailable"),
            endpoint("science", "science-id", "http://ollama-science:11434", "ready"),
          ],
          providerFor: () => science.provider,
        },
      },
    })).toThrow(/No dedicated endpoint for math/);
    expect(shared.calls).toBe(0);
    expect(science.calls).toBe(0);
  });
});

function endpoint(slug: string, departmentId: string, normalizedEndpoint: string, status: DedicatedServingInstance["status"]): DedicatedServingInstance {
  return {
    instanceId: `${slug}-instance`,
    departmentId,
    agentId: `${slug}-agent`,
    provider: "ollama",
    endpointReference: `serving://${slug}`,
    normalizedEndpoint,
    modelRegistryId: "model",
    modelVersion: "qwen3:8b",
    artifactDigest: null,
    deploymentMode: "dedicated",
    status,
    resourcePolicyId: "policy",
  };
}

function fakeProvider() {
  const state = { calls: 0 };
  const provider: InferenceProvider = {
    async generate() {
      state.calls += 1;
      return {
        text: "{}",
        servedModel: "qwen3-8b",
        usage: { inputTokens: 1, outputTokens: 1, source: "observed" },
        latencyMs: 1,
      };
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
  return { provider, get calls() { return state.calls; } };
}
