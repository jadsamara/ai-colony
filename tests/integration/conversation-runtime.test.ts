import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  AutonomyService,
  ConversationRunner,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  DomainError,
  MessagingService,
  ObjectiveService,
  routeObjective,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { compileCeoGraph, openCheckpointer, runCeoPass } from "@ai-colony/workflows";
import { readFileSync } from "node:fs";
import { ScriptedTransport } from "@ai-colony/messaging";
import { ADMIN_ID, auth, createTestApp, expectStatus } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const PRODUCT = "00000000-0000-4000-8000-000000000213";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const RESEARCH_DEPARTMENT = "00000000-0000-4000-8000-000000000018";
const REASONING_DEPARTMENT = "00000000-0000-4000-8000-00000000001a";
const PRODUCT_DEPARTMENT = "00000000-0000-4000-8000-00000000001d";

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

describe("autonomous conversation runtime", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  const authorizer = new Authorizer();
  let checkpointer: Awaited<ReturnType<typeof openCheckpointer>>;
  let now = Date.parse("2026-06-01T00:00:00.000Z");

  beforeAll(async () => {
    checkpointer = await openCheckpointer(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await checkpointer.end();
  });

  it("continues a four-department conversation from one start until a resolution", async () => {
    await seed(testDb());
    await enable();
    const transport = new ScriptedTransport();
    await transport.connect();
    await transport.provisionDepartment(SCIENCE_DEPARTMENT);
    const wakes: Array<{ jobId: string; conversationId: string; fence: number }> = [];
    const { dialogue, runner } = services({
      publish: async (payload) => {
        wakes.push(payload);
        await transport.publish({
          messageId: payload.jobId,
          routingKey: `department.${SCIENCE_DEPARTMENT}`,
          inboxDepartmentId: SCIENCE_DEPARTMENT,
          recipientAgentId: SCIENCE,
          body: Buffer.from(JSON.stringify(payload)),
          correlationId: "runtime",
          attempt: 1,
        });
      },
    });
    const provider = scripted();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "runtime-open",
    });
    const before = provider.requests.length;
    const result = await runner.run(admin(), opened.conversationId, provider, route);
    const record = await dialogue.read(admin(), opened.conversationId);
    expect(result.produced).toBeGreaterThanOrEqual(4);
    expect(record.turns.length).toBeGreaterThanOrEqual(5);
    expect(record.turns[1]?.departmentSlug).toBe("math");
    expect(record.turns.map((turn) => turn.body)).toEqual(expect.arrayContaining([
      "I disagree. The zero case fails.",
      "I will check the source.",
      "The cited result does not cover the zero case.",
      "I accept and will check the contradiction.",
      "Both approaches assume the domain was stated.",
      "The result is uncertain until the domain is stated.",
    ]));
    expect(record.activeDepartmentIds).toEqual(expect.arrayContaining([
      SCIENCE_DEPARTMENT,
      MATH_DEPARTMENT,
      RESEARCH_DEPARTMENT,
      REASONING_DEPARTMENT,
    ]));
    expect(record.conversation.status).toBe("resolved");
    expect(record.conversation.outcome).toBe("resolved");
    expect(record.conversation.finalConclusion).toContain("uncertain");
    expect(record.events.map((event) => event.action)).toEqual(expect.arrayContaining(["invited", "accepted"]));
    const runtime = await runner.status(admin(), opened.conversationId);
    expect(runtime.messageCount).toBe(record.turns.length);
    expect(runtime.inferenceRequests).toBeGreaterThanOrEqual(4);
    expect(runtime.lastInferenceLatencyMs).toBe(3);
    expect(runtime.runnerStatus).toBe("stopped");
    expect(wakes.length).toBeGreaterThanOrEqual(4);
    const deliveries = provider.requests.length;
    const first = wakes[0];
    expect(first).toBeTruthy();
    expect(await runner.handleDelivery(first!, provider, route, admin())).toEqual({ duplicate: true });
    expect(await runner.handleDelivery(first!, provider, route, admin())).toEqual({ duplicate: true });
    expect(provider.requests).toHaveLength(deliveries);
    expect(provider.requests.length).toBeGreaterThan(before);
    const settings = await persistence.repos.autonomy.settings();
    expect(settings.enabled).toBe(false);
    expect(settings.conversationExecutionEnabled).toBe(true);
    expect(readFileSync("packages/database/src/client.ts", "utf8")).toMatch(/max:\s*3/);
    expect(routeObjective("Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer.").path).toBe("direct");
  });

  it("pauses, resumes, declines an invitation, and closes without agreement", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = scripted();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "pause-open",
    });
    const blocking = blockingProvider();
    const running = runner.run(admin(), opened.conversationId, blocking.provider, route, { maxTurns: 1 });
    await blocking.started;
    await expect(
      dialogue.speak(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        kind: "response",
        instruction: "Manual turn during the runner lease.",
        idempotencyKey: "manual-during-lease",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await runner.pause(admin(), opened.conversationId);
    blocking.release();
    const paused = await running;
    expect(paused.produced).toBe(1);
    const calls = blocking.requests.length;
    const held = await runner.run(admin(), opened.conversationId, blocking.provider, route);
    expect(held.stop).toBe("paused");
    expect(blocking.requests).toHaveLength(calls);
    await runner.resume(admin(), opened.conversationId);
    const declined = scripted({ declineInvitation: true });
    await runner.run(admin(), opened.conversationId, declined, route);
    await expect(dialogue.read(agent(RESEARCH, RESEARCH_DEPARTMENT), opened.conversationId)).rejects.toMatchObject({ statusCode: 403 });
    const record = await dialogue.read(admin(), opened.conversationId);
    expect(record.turns.some((turn) => turn.body === "I disagree. The zero case fails.")).toBe(true);

    const closer = services();
    const closeProvider = scripted({ close: true });
    const second = await closer.dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), closeProvider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Should we stop?",
      kind: "question",
      instruction: "Math, should we stop?",
      idempotencyKey: "close-open",
    });
    await closer.runner.run(admin(), second.conversationId, closeProvider, route);
    const closed = await persistence.repos.autonomy.findConversation(second.conversationId);
    expect(closed?.status).toBe("unresolved");
    expect(closed?.outcome).toBe("unresolved");
    expect(closed?.finalConclusion).toBeNull();
  });

  it("enforces budgets, termination, cancellation, crash recovery, and duplicate scheduling", async () => {
    await seed(testDb());
    await enable();
    await persistence.repos.autonomy.saveSettings({ maxConversationMessages: 2 });
    const { dialogue, runner } = services();
    const provider = scripted();
    const limited = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "budget-open",
    });
    await runner.run(admin(), limited.conversationId, provider, route);
    const budget = await persistence.repos.autonomy.findConversation(limited.conversationId);
    expect(budget?.status).toBe("terminated");
    expect(budget?.closeReason).toBe("message_limit");
    expect(budget?.outcome).toBe("budget_exhausted");

    await persistence.repos.autonomy.saveSettings({ maxConversationMessages: 12 });
    const managed = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "terminate-open",
    });
    await expect(dialogue.terminate(agent(SCIENCE, SCIENCE_DEPARTMENT), managed.conversationId, "A participant tries to override the administrator.")).rejects.toMatchObject({ statusCode: 403 });
    const terminated = await dialogue.terminate(admin(), managed.conversationId, "Administrator stop.");
    expect(terminated.outcome).toBe("administratively_stopped");
    const afterStop = await runner.run(admin(), managed.conversationId, provider, route);
    expect(afterStop.produced).toBe(0);

    const collaborative = await expectStatus(
      await createTestApp(),
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: { objective: "Help me figure out what the colony should do next." },
      },
      201,
    );
    const linked = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Which gap should we inspect?",
      objectiveId: collaborative.objective.id,
      kind: "question",
      instruction: "The colony goal is still open.",
      idempotencyKey: "cancel-open",
    });
    const calls = provider.requests.length;
    await objectives().cancel(admin(), collaborative.objective.id);
    const cancelled = await runner.run(admin(), linked.conversationId, provider, route);
    expect(cancelled.produced).toBe(0);
    expect(provider.requests).toHaveLength(calls);
    expect((await persistence.repos.autonomy.findConversation(linked.conversationId))?.outcome).toBe("cancelled");

    const crashed = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "crash-open",
    });
    const failing = scripted({ failOnce: true });
    const clocked = services();
    await expect(clocked.runner.run(admin(), crashed.conversationId, failing, route, { maxTurns: 1 })).rejects.toThrow(/worker died/);
    now += 16_000;
    await clocked.runner.run(admin(), crashed.conversationId, failing, route, { maxTurns: 1 });
    const recovered = await dialogue.read(admin(), crashed.conversationId);
    expect(recovered.turns.filter((turn) => turn.body === "I disagree. The zero case fails.")).toHaveLength(1);
    expect(failing.requests.filter((request) => request.messages.some((message) => message.content.includes("Return one JSON object"))).length).toBeGreaterThanOrEqual(2);

    const deferred = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "defer-open",
    });
    const app = await createTestApp();
    const arithmetic = await expectStatus(
      app,
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: { objective: "Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer." },
      },
      201,
    );
    const graph = compileCeoGraph({ service: objectives(), provider: scripted(), route, workerId: "runtime-human", checkpointer });
    await runCeoPass(graph, objectives());
    const quiet = scripted();
    const first = await runner.run(admin(), deferred.conversationId, quiet, route);
    const second = await runner.run(admin(), deferred.conversationId, quiet, route);
    expect(first.stop).toBe("deferred");
    expect(second.stop).toBe("deferred");
    expect(quiet.requests).toHaveLength(0);
    expect((await persistence.repos.autonomy.findConversation(deferred.conversationId))?.runnerFence).toBe(1);
    await objectives().cancel(admin(), arithmetic.objective.id);
    await app.close();
  });

  it("keeps one shared inference slot, token provenance, and authorized history", async () => {
    await seed(testDb());
    await enable();
    await persistence.repos.autonomy.saveSettings({ maxConcurrentConversationTurns: 1, contextTokenBudget: 200 });
    const { dialogue, runner } = services();
    const firstProvider = blockingProvider();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), scripted(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: `${"Math, are the current assumptions adequate? ".repeat(40)}`,
      idempotencyKey: "pressure-open",
    });
    const second = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), scripted(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "A second conversation",
      kind: "question",
      instruction: "Math, look at the other question.",
      idempotencyKey: "pressure-second",
    });
    const running = runner.run(admin(), opened.conversationId, firstProvider.provider, route, { maxTurns: 1 });
    await firstProvider.started;
    const other = scripted();
    const blocked = await runner.run(admin(), second.conversationId, other, route, { maxTurns: 1 });
    expect(blocked.stop).toBe("backpressure");
    expect(other.requests).toHaveLength(0);
    firstProvider.release();
    await running;

    const finished = await runner.run(admin(), opened.conversationId, scripted(), route);
    expect(finished.produced).toBeGreaterThanOrEqual(1);
    const record = await dialogue.read(admin(), opened.conversationId);
    const summarized = record.turns.find((turn) => turn.prompt.some((message) => message.content.includes("summary (not a verbatim transcript)")));
    expect(summarized?.prompt.some((message) => message.content.includes("message "))).toBe(true);
    expect(record.turns[0]?.body).toContain("Math, are the current assumptions adequate?");
    const found = await dialogue.search(agent(SCIENCE, SCIENCE_DEPARTMENT), opened.conversationId, "assumptions", 5);
    expect(found.turns.some((turn) => turn.body.includes("assumptions") && turn.id === record.turns[0]?.id)).toBe(true);
    await expect(dialogue.search(agent(PRODUCT, PRODUCT_DEPARTMENT), opened.conversationId, "assumptions", 5)).rejects.toMatchObject({ statusCode: 403 });
    const runtime = await runner.status(admin(), opened.conversationId);
    expect(runtime.contextEvents.length).toBeGreaterThan(0);
    expect(runtime.lastInferenceLatencyMs).toBe(3);
  });

  it("does not enable goal generation when conversation execution is enabled", async () => {
    await seed(testDb());
    await enable();
    const autonomy = new AutonomyService(persistence, authorizer, objectives());
    const provider = scripted();
    expect((await autonomy.runCycle(admin(), provider, route)).outcome).toBe("disabled");
    expect(provider.requests).toHaveLength(0);
    await expect(services().runner.run(admin(), "00000000-0000-4000-8000-000000000099", provider, route)).rejects.toMatchObject({ statusCode: 404 });
    await persistence.repos.autonomy.saveSettings({ conversationExecutionEnabled: false });
    const { dialogue, runner } = services();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Stay manual",
      kind: "question",
      instruction: "Math, stay manual.",
      idempotencyKey: "disabled-open",
    });
    await expect(runner.run(admin(), opened.conversationId, provider, route)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("forms a working group, waits for its finding, and resumes the parent", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = scripted({ workingGroup: true });
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Parent assumptions",
      kind: "question",
      instruction: "Math, can a smaller group inspect the zero case?",
      idempotencyKey: "group-open",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 4 });
    const conversations = await persistence.repos.autonomy.listConversations(20);
    const child = conversations.find((conversation) => conversation.parentConversationId === opened.conversationId);
    expect(child?.finalConclusion).toContain("working group finding is uncertain");
    const parent = await dialogue.read(admin(), opened.conversationId);
    expect(parent.turns.some((turn) => turn.prompt.some((message) => message.content.includes("Working-group findings")))).toBe(true);
  });

  function services(wake?: { publish(payload: { jobId: string; conversationId: string; fence: number }): Promise<void> }) {
    const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY), () => new Date(now));
    const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now), wake, 1_000);
    return { dialogue, runner };
  }

  function objectives() {
    return new ObjectiveService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
  }

  async function enable() {
    now = Date.parse("2026-06-01T00:00:00.000Z");
    await persistence.repos.autonomy.saveSettings({ conversationExecutionEnabled: true, maxConcurrentConversationTurns: 1, contextTokenBudget: 1_500 });
  }
});

function scripted(options?: { failOnce?: boolean; declineInvitation?: boolean; close?: boolean; workingGroup?: boolean }) {
  let failed = false;
  return new ScriptedInferenceProvider((request) => {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const user = request.messages.map((message) => message.content).join("\n");
    if (!system.includes("Return one JSON object")) {
      const instruction = user.match(/Instruction: ([^\n]+)/)?.[1] ?? "Turn";
      return observed(request, instruction);
    }
    if (options?.failOnce && !failed) {
      failed = true;
      throw new Error("worker died before the turn was stored");
    }
    if (options?.close) {
      return observed(request, JSON.stringify({ kind: "close", body: "No further progress is available.", decision: "speak" }));
    }
    if (options?.workingGroup && user.includes("working group") && system.includes("You are the Math department")) {
      return observed(request, JSON.stringify({ kind: "resolution", body: "The working group finding is uncertain.", decision: "speak" }));
    }
    if (system.includes("You are the Math department") && !user.includes("I disagree")) {
      if (options?.workingGroup) {
        return observed(request, JSON.stringify({ kind: "response", body: "Math asks for a working group.", decision: "speak", workingGroup: ["math", "research"] }));
      }
      if (!user.includes("Authorized transcript matches")) {
        return observed(request, JSON.stringify({ kind: "response", body: "I need the earlier assumption.", decision: "speak", searchQuery: "assumptions" }));
      }
      return observed(request, JSON.stringify({ kind: "disagreement", body: "I disagree. The zero case fails.", addressedSlug: "science", inviteSlug: "research", decision: "speak" }));
    }
    if (system.includes("You are the Math department")) {
      return observed(request, JSON.stringify({ kind: "response", body: "Math keeps the zero case open.", decision: "speak" }));
    }
    if (options?.declineInvitation && user.includes("You were invited")) {
      return observed(request, JSON.stringify({ kind: "response", body: "Research declines this invitation.", decision: "decline" }));
    }
    if (system.includes("You are the Research department") && user.includes("You were invited") && !user.includes("I will check the source.")) {
      return observed(request, JSON.stringify({ kind: "agreement", body: "I will check the source.", decision: "accept" }));
    }
    if (system.includes("You are the Research department") && !user.includes("The cited result does not cover the zero case.")) {
      return observed(request, JSON.stringify({ kind: "evidence", body: "The cited result does not cover the zero case.", inviteSlug: "reasoning", decision: "speak" }));
    }
    if (system.includes("You are the Research department")) {
      return observed(request, JSON.stringify({ kind: "response", body: "Research is comparing the cited boundary.", decision: "speak" }));
    }
    if (system.includes("You are the Reasoning department") && user.includes("You were invited")) {
      return observed(request, JSON.stringify({ kind: "agreement", body: "I accept and will check the contradiction.", decision: "accept" }));
    }
    if (system.includes("You are the Reasoning department")) {
      return observed(request, JSON.stringify({ kind: "challenge", body: "Both approaches assume the domain was stated.", addressedSlug: "science", decision: "speak" }));
    }
    if (system.includes("You are the Science department") && (user.includes("Both approaches") || user.includes("challenge"))) {
      return observed(request, JSON.stringify({ kind: "resolution", body: "The result is uncertain until the domain is stated.", decision: "speak" }));
    }
    if (system.includes("You are the Science department")) {
      return observed(request, JSON.stringify({ kind: "response", body: "The zero case needs a source.", decision: "speak" }));
    }
    return observed(request, JSON.stringify({ kind: "close", body: "No further progress is available.", decision: "speak" }));
  });
}

function blockingProvider() {
  let release: (value?: void) => void = () => undefined;
  let markStarted: (value?: void) => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: InferenceRequest[] = [];
  let blocked = false;
  const provider: InferenceProvider = {
    async generate(request) {
      requests.push(request);
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!blocked && system.includes("Return one JSON object")) {
        blocked = true;
        markStarted();
        await released;
      }
      return observed(request, JSON.stringify({ kind: "disagreement", body: "I disagree. The zero case fails.", addressedSlug: "science", inviteSlug: "research", decision: "speak" }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
  return { provider, requests, started, release: () => release() };
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
    correlationId: "runtime",
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
    correlationId: "runtime",
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
