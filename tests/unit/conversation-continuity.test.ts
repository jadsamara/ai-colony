import { describe, expect, it } from "vitest";
import {
  assessProgress,
  departmentFollowUp,
  isNearVerbatim,
  permitsEcho,
  selectConversationInference,
  type DedicatedServingInstance,
  type InferenceProvider,
  type InferenceRoute,
} from "@ai-colony/core";

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

describe("conversation continuity", () => {
  it("gives a department its own follow-up and allows agreement and a short quotation", () => {
    expect(departmentFollowUp("math")).toContain("calculation");
    expect(departmentFollowUp("science")).toContain("hypothesis");
    expect(departmentFollowUp("science")).not.toContain("ollama-math");
    const prior = "The zero case fails when the domain is empty.";
    expect(isNearVerbatim(prior, [prior])).toBe(true);
    expect(permitsEcho("Agreed.", "agreement", [prior])).toBe(true);
    expect(permitsEcho(`The note "${prior}" still needs an independent quantity check.`, "response", [prior])).toBe(true);
    expect(permitsEcho(`"${prior}"`, "response", [prior])).toBe(false);
  });

  it("continues a checkpoint when the window has a new contribution", () => {
    const progress = assessProgress([
      { id: "m1", department: "science", kind: "question", body: "Is the quantity known?" },
      { id: "m2", department: "math", kind: "response", body: "The calculation gives 4." },
    ], 2);
    expect(progress.decision).toBe("continue");
    expect(progress.justified).toBe(true);
    expect(progress.contributions).toBeGreaterThan(0);
    expect(progress.summary).toContain("message m1");
  });

  it("redirects or concludes only when the recent window adds nothing", () => {
    const repeated = "The same sentence is being repeated here.";
    const stalled = assessProgress([
      { id: "m1", department: "science", kind: "response", body: "A finished note." },
      { id: "m2", department: "math", kind: "response", body: repeated },
      { id: "m3", department: "science", kind: "response", body: repeated },
    ], 1);
    expect(stalled.decision).toBe("conclude");
    expect(stalled.justified).toBe(false);
    const waiting = assessProgress([
      { id: "m1", department: "science", kind: "question", body: "Which citation supports the zero case?" },
      { id: "m2", department: "science", kind: "response", body: repeated },
      { id: "m3", department: "science", kind: "response", body: repeated },
    ], 1);
    expect(waiting.decision).toBe("invite");
    expect(waiting.inviteSlug).toBe("research");
    expect(waiting.justified).toBe(true);
  });

  it("routes math to its own endpoint and keeps a single endpoint when dedicated routing is off", async () => {
    const math = fakeProvider();
    const science = fakeProvider();
    const shared = fakeProvider();
    const dedicated = selectConversationInference({
      departmentId: "math-id",
      departmentSlug: "math",
      shared: shared.provider,
      route: {
        ...route,
        dedicatedRouting: {
          enabled: true,
          instances: [endpoint("math", "math-id", "http://ollama-math:11434"), endpoint("science", "science-id", "http://ollama-science:11434")],
          providerFor: (id) => id === "math-instance" ? math.provider : science.provider,
        },
      },
    });
    await dedicated.provider.generate(request());
    expect(math.calls).toBe(1);
    expect(science.calls).toBe(0);
    expect(shared.calls).toBe(0);
    expect(dedicated.metadata).toContain("department=math");
    expect(dedicated.metadata).toContain("endpoint=http://ollama-math:11434");
    expect(dedicated.metadata).not.toContain("ollama-science");
    expect(() => selectConversationInference({
      departmentId: "math-id",
      departmentSlug: "math",
      shared: shared.provider,
      route: {
        ...route,
        dedicatedRouting: {
          enabled: true,
          instances: [endpoint("math", "math-id", "http://ollama-science:11434")],
          providerFor: () => science.provider,
        },
      },
    })).toThrow(/Refusing inference host ollama-science/);
    expect(() => selectConversationInference({
      departmentId: "math-id",
      departmentSlug: "math",
      shared: shared.provider,
      route: {
        ...route,
        dedicatedRouting: {
          enabled: true,
          instances: [endpoint("math", "math-id", "http://user:secret@ollama-science:11434")],
          providerFor: () => science.provider,
        },
      },
    })).toThrow(/credentials/);
    expect(science.calls).toBe(0);
    const single = selectConversationInference({
      departmentId: "math-id",
      departmentSlug: "math",
      shared: shared.provider,
      route,
    });
    expect(single.provider).toBe(shared.provider);
    expect(single.metadata).toContain("endpoint=shared");
  });
});

function endpoint(slug: string, departmentId: string, normalizedEndpoint: string): DedicatedServingInstance {
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
    status: "ready",
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

function request() {
  return {
    requestId: "request",
    registryModelId: "model",
    modelAlias: "qwen3-8b",
    messages: [{ role: "user" as const, content: "hello" }],
    temperature: 0,
    maxOutputTokens: 16,
    timeoutMs: 1000,
    jsonObject: true,
  };
}
