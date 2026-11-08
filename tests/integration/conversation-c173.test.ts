import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  ConversationRunner,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  MAX_INVALID_CORRECTIONS,
  MessagingService,
  TrainingEvidenceService,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const MATH = "00000000-0000-4000-8000-000000000204";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const RESEARCH_DEPARTMENT = "00000000-0000-4000-8000-000000000018";

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
let now = Date.parse("2026-06-07T00:00:00.000Z");

describe("C1.7.3 reliable dynamic collaboration", () => {
  it("rejects an invalid kind, corrects on a later attempt, and preserves prior turns", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({ kind: "essay", body: "An invalid essay kind." }),
      JSON.stringify({ kind: "analysis", body: "Still not a valid kind." }),
      JSON.stringify({ kind: "response", body: "The zero case remains open after correction.", decision: "speak" }),
    ]);
    const conversationId = await openConversation(dialogue, provider, "c173-kind-ok");
    const before = await dialogue.read(admin(), conversationId);
    expect(before.turns.length).toBeGreaterThanOrEqual(1);
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const after = await dialogue.read(admin(), conversationId);
    expect(after.turns.some((turn) => turn.body === before.turns[0]?.body)).toBe(true);
    expect(after.turns.some((turn) => turn.body === "The zero case remains open after correction.")).toBe(true);
    expect(after.turns.every((turn) => turn.kind !== "essay")).toBe(true);
    const runnerCalls = provider.requests.filter((request) => request.messages.some((message) => message.content.includes("Return one JSON object")));
    expect(runnerCalls).toHaveLength(MAX_INVALID_CORRECTIONS + 1);
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    expect(stored?.status).toBe("open");
    expect(stored?.lastError).toBeNull();
    expect(stored?.progressState.failedGenerations.length).toBe(2);
    expect(stored?.progressState.failedGenerations.every((item) => item.diagnostic.includes("kind: invalid value"))).toBe(true);
    expect(stored?.progressState.inferenceLog.some((item) => item.status === "recovered")).toBe(true);
  });

  it("stops after exhausting invalid-output corrections without fabricating a conclusion", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = outputsProvider([
      JSON.stringify({ kind: "essay", body: "first invalid" }),
      JSON.stringify({ kind: "analysis", body: "second invalid" }),
      JSON.stringify({ kind: "statement", body: "third invalid" }),
      JSON.stringify({ kind: "response", body: "should never be stored", decision: "speak" }),
    ]);
    const conversationId = await openConversation(dialogue, provider, "c173-kind-exhausted");
    const priorTurns = (await dialogue.read(admin(), conversationId)).turns.length;
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    const runtime = await runner.status(admin(), conversationId);
    const turns = await persistence.repos.autonomy.listTurns(conversationId);
    expect(stored?.status).toBe("terminated");
    expect(stored?.closeReason).toBe("model_invalid");
    expect(stored?.outcome).toBe("failed");
    expect(stored?.finalConclusion).toBeNull();
    expect(turns).toHaveLength(priorTurns);
    expect(turns.every((turn) => turn.body !== "should never be stored")).toBe(true);
    expect(runtime.failedGenerations.length).toBeGreaterThanOrEqual(3);
    expect(runtime.inferenceLog.length).toBeGreaterThanOrEqual(3);
    expect(runtime.lastError?.startsWith("model_invalid:")).toBe(true);
    expect(runtime.progress.terminationReason).toBe("model_invalid");
    const listed = await evidence.listAttempts(admin(), { conversationId, limit: 50 });
    expect(listed.data.filter((row) => row.acceptanceStatus === "rejected").length).toBeGreaterThanOrEqual(3);
    expect(provider.requests.filter((request) => request.messages.some((message) => message.content.includes("Return one JSON object")))).toHaveLength(3);
  });

  it("stops recovery safely when the token budget cannot cover another correction", async () => {
    await seed(testDb());
    await enable();
    await persistence.repos.autonomy.saveSettings({ conversationSoftTokenBudget: 20, conversationHardTokenCeiling: 45 });
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({ kind: "essay", body: "budget invalid" }),
      JSON.stringify({ kind: "response", body: "should not run", decision: "speak" }),
    ]);
    const conversationId = await openConversation(dialogue, provider, "c173-budget");
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    const runtime = await runner.status(admin(), conversationId);
    expect(stored?.status).toBe("terminated");
    expect(stored?.closeReason).toBe("model_invalid");
    expect(stored?.finalConclusion).toBeNull();
    expect(runtime.lastError).toMatch(/budget|ceiling|token/i);
    expect(runtime.failedGenerations.length).toBeGreaterThanOrEqual(1);
    expect(runtime.inferenceLog.some((entry) => entry.status === "failed")).toBe(true);
    expect(provider.requests.filter((request) => request.messages.some((message) => message.content.includes("Return one JSON object")))).toHaveLength(1);
  });

  it("keeps rejected attempts durable and does not wipe diagnostics on terminate", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = outputsProvider([
      "not-json SECRET-SHOULD-NOT-LEAK",
      '{"kind":"essay","body":"still bad"}',
      '{"kind":"analysis","body":"still bad"}',
    ]);
    const conversationId = await openConversation(dialogue, provider, "c173-evidence", "private-topic-token");
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const runtime = await runner.status(admin(), conversationId);
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    expect(runtime.failedGenerations.length).toBe(stored?.progressState.failedGenerations.length);
    expect(runtime.inferenceLog.length).toBe(stored?.progressState.inferenceLog.length);
    expect(runtime.failedGenerations.length).toBeGreaterThanOrEqual(3);
    expect(runtime.lastError).not.toContain("SECRET-SHOULD-NOT-LEAK");
    expect(runtime.lastError).not.toContain("private-topic-token");
    const listed = await evidence.listAttempts(admin(), { conversationId, limit: 50 });
    expect(listed.data.filter((row) => row.acceptanceStatus === "rejected").length).toBeGreaterThanOrEqual(3);
    const rejectedId = listed.data.find((row) => row.acceptanceStatus === "rejected")!.id;
    const withRaw = await evidence.getAttempt(admin(), rejectedId, true);
    expect(withRaw.attempt.rawOutput).toBeTruthy();
    expect(withRaw.attempt.validationResult).toBeTruthy();
  });

  it("replays an accepted runner turn idempotently without duplicating transcript rows", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({ kind: "response", body: "Idempotent contribution about the zero case.", decision: "speak" }),
    ]);
    const conversationId = await openConversation(dialogue, provider, "c173-idempotent");
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const first = await dialogue.read(admin(), conversationId);
    const matching = first.turns.filter((turn) => turn.body === "Idempotent contribution about the zero case.");
    expect(matching).toHaveLength(1);
    const jobKey = matching[0]!.idempotencyKey;
    expect(jobKey.startsWith("runner:")).toBe(true);
    const replay = await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, conversationId, {
      kind: "response",
      instruction: "Idempotent contribution about the zero case.",
      idempotencyKey: jobKey,
    });
    expect(replay.id).toBe(matching[0]!.id);
    const second = await dialogue.read(admin(), conversationId);
    expect(second.turns.filter((turn) => turn.body === "Idempotent contribution about the zero case.")).toHaveLength(1);
    expect(second.turns).toHaveLength(first.turns.length);
  });

  it("schedules a dynamically joined specialist into the same transcript", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = specialistProvider();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "c173-join-open",
    });
    await dialogue.seatInvitee(agent(SCIENCE, SCIENCE_DEPARTMENT), opened.conversationId, RESEARCH_DEPARTMENT, "Need citation checks");
    await dialogue.accept(agent(RESEARCH, RESEARCH_DEPARTMENT), opened.conversationId);
    const membership = await persistence.repos.autonomy.listMembership(opened.conversationId);
    expect(membership.some((row) => row.departmentId === RESEARCH_DEPARTMENT && row.membership === "active")).toBe(true);
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 4 });
    const record = await dialogue.read(admin(), opened.conversationId);
    expect(record.activeDepartmentIds).toEqual(expect.arrayContaining([SCIENCE_DEPARTMENT, MATH_DEPARTMENT, RESEARCH_DEPARTMENT]));
    expect(record.turns.some((turn) => turn.departmentSlug === "research")).toBe(true);
    expect(record.turns.some((turn) => turn.body.includes("citation boundary"))).toBe(true);
    expect(record.turns.some((turn) => turn.departmentSlug === "math")).toBe(true);
  });
});

function services() {
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY), () => new Date(now += 1000));
  const evidence = new TrainingEvidenceService(persistence, authorizer, undefined, () => new Date(now += 1000));
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now += 1000), undefined, 1000);
  return { dialogue, runner, evidence };
}

async function enable() {
  now = Date.parse("2026-06-07T00:00:00.000Z");
  await persistence.repos.autonomy.saveSettings({
    conversationExecutionEnabled: true,
    maxConcurrentConversationTurns: 1,
    maxConversationMessages: 12,
    conversationCheckpointTurns: 10,
    conversationSoftTokenBudget: 20_000,
    conversationHardTokenCeiling: 60_000,
  });
}

async function openConversation(dialogue: DialogueService, provider: InferenceProvider, key: string, topic = "Are the current mathematical assumptions adequate?") {
  const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
    recipientDepartmentId: MATH_DEPARTMENT,
    topic,
    kind: "question",
    instruction: "Math, are the current assumptions adequate?",
    idempotencyKey: key,
  });
  return opened.conversationId;
}

function outputsProvider(outputs: string[]) {
  let index = 0;
  return new ScriptedInferenceProvider((request) => {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    if (!system.includes("Return one JSON object")) {
      const user = request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
      const instruction = user.match(/Instruction: ([^\n]+)/)?.[1] ?? "Turn";
      return observed(request, instruction);
    }
    const text = outputs[index] ?? outputs.at(-1) ?? "{}";
    index += 1;
    return observed(request, text);
  });
}

function specialistProvider(): InferenceProvider & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  const provider: InferenceProvider & { requests: InferenceRequest[] } = {
    requests,
    async generate(request) {
      requests.push(request);
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        const user = request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
        const instruction = user.match(/Instruction: ([^\n]+)/)?.[1] ?? "Turn";
        return observed(request, instruction);
      }
      if (system.includes("You are the Math department")) {
        return observed(request, JSON.stringify({ kind: "disagreement", body: "The zero case fails under the stated domain.", addressedSlug: "science", decision: "speak" }));
      }
      if (system.includes("You are the Research department")) {
        return observed(request, JSON.stringify({ kind: "evidence", body: "The citation boundary excludes the zero case.", decision: "speak" }));
      }
      if (system.includes("You are the Science department")) {
        return observed(request, JSON.stringify({ kind: "response", body: "Science awaits the citation check.", decision: "speak" }));
      }
      return observed(request, JSON.stringify({ kind: "response", body: "Continuing the evaluation.", decision: "speak" }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
  return provider;
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return {
    text,
    servedModel: request.modelAlias,
    usage: { inputTokens: 8, outputTokens: 12, source: "observed" },
    latencyMs: 3,
  };
}

function admin(): RequestContext {
  return {
    correlationId: "c173",
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

function agent(id: string, departmentId: string): RequestContext {
  return {
    correlationId: "c173",
    actor: {
      principalId: id,
      principalType: "agent",
      role: "department_agent",
      agentId: id,
      departmentId,
      permissions: [],
    },
  };
}
