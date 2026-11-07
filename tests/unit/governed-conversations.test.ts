import { describe, expect, it } from "vitest";
import { departmentContributions, orchestrationRecommendation, selectConversationInference, type InferenceProvider, type InferenceRoute } from "@ai-colony/core";

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

describe("governed conversations", () => {
  it("lets orchestration recommend from the question and expertise instead of rotating seats", () => {
    const participants = [
      { id: "science", slug: "science", name: "Science" },
      { id: "math", slug: "math", name: "Math" },
      { id: "research", slug: "research", name: "Research" },
    ];
    const choice = orchestrationRecommendation({
      participants,
      turns: [{
        departmentId: "science",
        departmentSlug: "science",
        kind: "question",
        body: "Which citation supports the continual-learning claim?",
        addressedDepartmentId: null,
      }],
      topic: "continual learning",
      remainingMessages: 8,
    });
    expect(choice).toMatchObject({ departmentId: "research", source: "orchestration", reason: "expertise" });
    expect(choice?.departmentId).not.toBe("math");
  });

  it("keeps contribution, disagreement, question, and evidence totals by department", () => {
    const ledger = departmentContributions([
      { department: "science", kind: "question" },
      { department: "math", kind: "disagreement" },
      { department: "research", kind: "evidence" },
      { department: "evaluation", kind: "close" },
    ]);
    expect(ledger.science).toMatchObject({ questions: 1, contributions: 1 });
    expect(ledger.math).toMatchObject({ disagreements: 1, contributions: 1 });
    expect(ledger.research).toMatchObject({ evidence: 1, contributions: 1 });
    expect(ledger.evaluation).toMatchObject({ contributions: 0 });
  });

  it("refuses an unavailable department endpoint without calling another department", () => {
    const shared = fake();
    const science = fake();
    expect(() => selectConversationInference({
      departmentId: "reasoning-id",
      departmentSlug: "reasoning",
      shared: shared.provider,
      route: {
        ...route,
        dedicatedRouting: {
          enabled: true,
          instances: [
            endpoint("reasoning", "reasoning-id", "http://ollama-reasoning:11434", "unavailable"),
            endpoint("science", "science-id", "http://ollama-science:11434", "ready"),
          ],
          providerFor: () => science.provider,
        },
      },
    })).toThrow(/No dedicated endpoint for reasoning/);
    expect(shared.calls).toBe(0);
    expect(science.calls).toBe(0);
  });
});

function endpoint(slug: string, departmentId: string, normalizedEndpoint: string, status: "ready" | "unavailable") {
  return {
    instanceId: `${slug}-instance`,
    departmentId,
    agentId: `${slug}-agent`,
    provider: "ollama" as const,
    endpointReference: `serving://${slug}`,
    normalizedEndpoint,
    modelRegistryId: "model",
    modelVersion: "qwen3:8b",
    artifactDigest: null,
    deploymentMode: "dedicated" as const,
    status,
    resourcePolicyId: "policy",
  };
}

function fake() {
  const state = { calls: 0 };
  const provider: InferenceProvider = {
    async generate() {
      state.calls += 1;
      return { text: "{}", servedModel: "qwen3-8b", usage: { inputTokens: 1, outputTokens: 1, source: "observed" }, latencyMs: 1 };
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
  return { provider, get calls() { return state.calls; } };
}
