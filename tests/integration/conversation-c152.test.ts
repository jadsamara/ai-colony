import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  ConversationRunner,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  MessagingService,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const INSTRUCTION = "Independently evaluate continual-learning methods. Challenge unsupported mathematical claims and produce a concrete experimental protocol.";
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

const persistence = createPersistence(testDb(), async () => undefined);
let now = Date.parse("2026-06-04T00:00:00.000Z");

describe("C1.5.2 conversation integrity and recovery", () => {
  it("rejects parser-error bodies, recovers with a valid turn, and keeps the original instruction", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = recoveringProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c152-recover-0001",
    });
    const result = await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 3 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(result.research.status).toBeDefined();
    expect(turns.some((turn) => /previous JSON failed validation/i.test(turn.body))).toBe(false);
    expect(
      stored?.progressState.failedGenerations.some((item) =>
        item.reason === "invalid_output"
        || item.diagnostic.includes("parser")
        || item.diagnostic.includes("validation"),
      )
      || stored?.progressState.turnDecisions.some((decision) => decision.includes("retried") || decision.includes("rejected")),
    ).toBe(true);
    expect(turns.some((turn) => turn.body.includes("Fisher information"))).toBe(true);
    expect(turns.every((turn) => turn.prompt.some((message) => message.content.includes(INSTRUCTION)))).toBe(true);
    expect(stored?.progressState.inferenceLog.some((item) => item.departmentSlug === "math" && (item.status === "accepted" || item.status === "recovered"))).toBe(true);
  });

  it("rejects a repetitive proposal instead of counting it as progress", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = repetitiveProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c152-repeat-0001",
    });
    const result = await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 4 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(turns.filter((turn) => /continual learning framework assumes replay/i.test(turn.body)).length).toBeLessThanOrEqual(1);
    expect(stored?.progressState.failedGenerations.length ?? 0).toBeGreaterThan(0);
    expect(result.research.substantialProgress).toBe(false);
  });

  it("closes at the message limit with message_limit rather than no_speaker", async () => {
    await seed(testDb());
    await enable();
    await persistence.repos.autonomy.saveSettings({ maxConversationMessages: 2, conversationCheckpointTurns: 10 });
    const { dialogue, runner } = services();
    const provider = advancingProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c152-limit-0001",
    });
    const result = await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 4 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(stored?.status).toBe("terminated");
    expect(stored?.closeReason).toBe("message_limit");
    expect(result.stop).toBe("closed");
    expect(result.execution.stop).toBe("closed");
    expect(result.research.status).toBe("terminated");
    expect(result.research.closeReason).toBe("message_limit");
    expect(result.research.outcome).toBe("budget_exhausted");
    expect(result.research.finalConclusion).toBeNull();
    expect(result.research.outcome).not.toBe("resolved");
  });

  it("records dedicated routing metadata without falling back across departments", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const mathProvider = taggedProvider("math-only");
    const scienceProvider = taggedProvider("science-only");
    const dedicated: InferenceRoute = {
      ...route,
      dedicatedRouting: {
        enabled: true,
        instances: [
          serving("science", SCIENCE_DEPARTMENT, "http://mock-science:8080"),
          serving("math", MATH_DEPARTMENT, "http://mock-math:8080"),
        ],
        providerFor(instanceId) {
          if (instanceId === "science-instance") {
            return scienceProvider;
          }
          if (instanceId === "math-instance") {
            return mathProvider;
          }
          return null;
        },
      },
    };
    const opened = await dialogue.open(agent(), scienceProvider, dedicated, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c152-route-0001",
    });
    await runner.run(admin(), opened.conversationId, scienceProvider, dedicated, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(stored?.lastInferenceEndpoint).toContain("department=math");
    expect(stored?.lastInferenceEndpoint).toContain("endpoint=http://mock-math:8080");
    expect(stored?.progressState.inferenceLog.at(-1)?.endpoint).toContain("mock-math");
    expect(stored?.progressState.inferenceLog.at(-1)?.departmentSlug).toBe("math");
  });
});

function services() {
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY), () => new Date(now += 1000));
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now += 1000), undefined, 1000);
  return { dialogue, runner };
}

async function enable() {
  now = Date.parse("2026-06-04T00:00:00.000Z");
  await persistence.repos.autonomy.saveSettings({
    conversationExecutionEnabled: true,
    maxConcurrentConversationTurns: 1,
    maxConversationMessages: 12,
    conversationCheckpointTurns: 5,
  });
}

function recoveringProvider(): InferenceProvider {
  let runnerCalls = 0;
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, "What assumptions separate replay from EWC?");
      }
      runnerCalls += 1;
      if (runnerCalls === 1) {
        return observed(request, JSON.stringify({
          kind: "response",
          body: "The previous JSON failed validation because it did not include the required fields 'kind' and 'body'. Here is the corrected JSON object with the required fields.",
          decision: "speak",
        }));
      }
      return observed(request, JSON.stringify({
        kind: "response",
        body: "Let F be the Fisher information for task A. Assume η is the learning rate. Example: the EWC penalty is (1/2) * F * (θ - θA)^2 because F weights important parameters.",
        decision: "speak",
      }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function repetitiveProvider(): InferenceProvider {
  const repeated = "The continual learning framework assumes replay, EWC, and parameter isolation prevent catastrophic forgetting under static data distributions.";
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, repeated);
      }
      return observed(request, JSON.stringify({
        kind: "proposal",
        body: "The continual learning approach and framework still assume replay methods and EWC remain effective against catastrophic forgetting under static data.",
        decision: "speak",
      }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function advancingProvider(): InferenceProvider {
  let count = 0;
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, "Opening question about continual learning.");
      }
      count += 1;
      return observed(request, JSON.stringify({
        kind: "proposal",
        body: `Proposal ${count}: compare replay and EWC on two tasks with a held-out accuracy metric.`,
        decision: "speak",
      }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function taggedProvider(tag: string): InferenceProvider {
  let count = 0;
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, `Opening from ${tag}`);
      }
      count += 1;
      return observed(request, JSON.stringify({
        kind: "response",
        body: `${tag} contribution ${count}: state one measurable comparison between replay and EWC.`,
        decision: "speak",
      }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function serving(slug: string, departmentId: string, normalizedEndpoint: string) {
  return {
    instanceId: `${slug}-instance`,
    departmentId,
    agentId: `${slug}-agent`,
    provider: "ollama" as const,
    endpointReference: `serving://${slug}`,
    normalizedEndpoint,
    modelRegistryId: "00000000-0000-4000-8000-000000000101",
    modelVersion: "qwen3:8b",
    artifactDigest: null,
    deploymentMode: "dedicated" as const,
    status: "ready" as const,
    resourcePolicyId: "policy",
  };
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return { text, servedModel: request.modelAlias, usage: { inputTokens: 8, outputTokens: 12, source: "observed" }, latencyMs: 3 };
}

function admin(): RequestContext {
  return {
    correlationId: "c152",
    actor: {
      principalId: SYSTEM_ADMINISTRATOR_ID,
      principalType: "system",
      role: "system_administrator",
      agentId: null,
      departmentId: null,
      permissions: [],
    },
  };
}

function agent(): RequestContext {
  return {
    correlationId: "c152",
    actor: {
      principalId: SCIENCE,
      principalType: "agent",
      role: "department_agent",
      agentId: SCIENCE,
      departmentId: SCIENCE_DEPARTMENT,
      permissions: [],
    },
  };
}
