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
const REPEATED = "What measurement separates replay from EWC?";
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
let now = Date.parse("2026-06-03T00:00:00.000Z");

describe("conversation repetition recovery", () => {

  it("hands a repeated draft to the other department for synthesis", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ conversationExecutionEnabled: true, maxConcurrentConversationTurns: 1 });
    const { dialogue, runner } = services();
    const provider = switchingProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: "Compare replay and EWC.",
      idempotencyKey: "recovery-switch-0001",
    });
    const result = await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 6 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(result.stop).not.toBe("failed");
    expect(stored?.status).toBe("resolved");
    expect(stored?.closeReason).toBe("resolution");
    expect(turns.map((turn) => turn.departmentSlug)).toEqual(["science", "math", "math"]);
    expect(turns.filter((turn) => turn.body === REPEATED)).toHaveLength(1);
    expect(turns.at(-1)?.body).toContain("open question");
    expect(stored?.evidenceRefs).toEqual([]);
  });

  it("closes with no_progress after the bounded recovery limit", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ conversationExecutionEnabled: true, maxConcurrentConversationTurns: 1 });
    const { dialogue, runner } = services();
    const provider = repeatingProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: "Compare replay and EWC.",
      idempotencyKey: "recovery-bound-0001",
    });
    const result = await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 8 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(result.stop).toBe("unresolved");
    expect(stored?.status).toBe("unresolved");
    expect(stored?.closeReason).toBe("no_progress");
    expect(stored?.progressState.terminationReason).toBe("no_progress");
    expect(stored?.progressState.recoveryTotal).toBeGreaterThanOrEqual(3);
    expect(stored?.lastError).toContain("Unresolved questions");
    expect(turns).toHaveLength(1);
  });
});

function services() {
  const authorizer = new Authorizer();
  const persistence = createPersistence(testDb(), async () => undefined);
  const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY), () => new Date(now += 1000));
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now += 1000), undefined, 1000);
  return { dialogue, runner };
}

function switchingProvider(): InferenceProvider {
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const user = request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
      if (!system.includes("Return one JSON object")) {
        return observed(request, REPEATED);
      }
      if (user.includes("repeated a recent turn") || !system.includes("You are the Math department")) {
        return observed(request, JSON.stringify({ kind: "response", body: REPEATED, decision: "speak" }));
      }
      if (user.includes("previous department repeated") || user.includes("Synthesize the findings")) {
        return observed(request, JSON.stringify({
          kind: "resolution",
          body: "Synthesis: compare replay with EWC on two tasks. An open question remains about buffer size.",
          decision: "speak",
        }));
      }
      return observed(request, JSON.stringify({
        kind: "response",
        body: "Let the buffer hold 32 examples. The worked example is 16 + 16 = 32 because both counts are examples.",
        decision: "speak",
      }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function repeatingProvider(): InferenceProvider {
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, REPEATED);
      }
      return observed(request, JSON.stringify({ kind: "response", body: REPEATED, decision: "speak" }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return { text, servedModel: request.modelAlias, usage: { inputTokens: 8, outputTokens: 12, source: "observed" }, latencyMs: 3 };
}

function admin(): RequestContext {
  return {
    correlationId: "recovery",
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
    correlationId: "recovery",
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
