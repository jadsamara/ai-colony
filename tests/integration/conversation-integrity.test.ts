import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID as _ADMIN } from "@ai-colony/contracts";
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
import { ScriptedInferenceProvider } from "@ai-colony/inference";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const INSTRUCTION = "Science and Math: independently evaluate continual-learning methods. Identify weaknesses, propose testable experiments, and work toward a concrete research plan.";
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

describe("conversation integrity runtime", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  let now = Date.parse("2026-06-02T00:00:00.000Z");

  it("keeps the original instruction and repaired mathematics through a checkpoint and resume", async () => {
    await seed(testDb());
    now = Date.parse("2026-06-02T00:00:00.000Z");
    const authorizer = new Authorizer();
    const messaging = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY);
    const dialogue = new DialogueService(persistence, authorizer, messaging, () => new Date(now));
    const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now += 1000), undefined, 1000);
    const admin = administrator();
    await persistence.repos.autonomy.saveSettings({ conversationExecutionEnabled: true, conversationCheckpointTurns: 2 });
    const opened = await dialogue.open(agent(), new ScriptedInferenceProvider((request) => observed(request, "The opening question is whether continual learning can avoid forgetting.")), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "integrity-open-0001",
    });
    const latex = String.raw`{"kind":"response","body":"The proposed term is \frac{1}{2}.","decision":"speak"}`;
    const first = await runner.run(admin, opened.conversationId, sequence([latex]), route, { maxTurns: 1 });
    expect(first.stop).not.toBe("failed");
    const after = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(after?.openingInstruction).toBe(INSTRUCTION);
    expect(turns.at(-1)?.body).toContain(String.raw`\frac`);
    expect(turns.at(-1)?.body).not.toMatch(/[\u0008\u000c]/);
    expect(turns.at(-1)?.prompt.some((message) => message.content.includes(INSTRUCTION))).toBe(true);
    expect(after?.contextSummary).toContain(INSTRUCTION);
    await runner.pause(admin, opened.conversationId);
    await runner.resume(admin, opened.conversationId);
    const resumed = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(resumed?.openingInstruction).toBe(INSTRUCTION);
    expect(resumed?.contextSummary).toContain("Original instruction");
  });
});

function sequence(outputs: string[]): InferenceProvider {
  let index = 0;
  return {
    async generate(request): Promise<InferenceResult> {
      const text = outputs[Math.min(index, outputs.length - 1)] ?? JSON.stringify({ kind: "close", body: "No further progress is available.", decision: "speak" });
      index += 1;
      return observed(request, text);
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return { text, servedModel: request.modelAlias, usage: { inputTokens: 8, outputTokens: 12, source: "observed" }, latencyMs: 3 };
}

function administrator(): RequestContext {
  return {
    correlationId: "integrity",
    actor: {
      principalId: _ADMIN,
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
    correlationId: "integrity",
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
