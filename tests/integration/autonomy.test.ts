import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID, type DialogueKind } from "@ai-colony/contracts";
import {
  Authorizer,
  AutonomyService,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  DomainError,
  MessagingService,
  ObjectiveService,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { openCheckpointer, compileCeoGraph, runCeoPass } from "@ai-colony/workflows";
import { ADMIN_ID, auth, createTestApp, expectStatus } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

const MATH = "00000000-0000-4000-8000-000000000204";
const SCIENCE = "00000000-0000-4000-8000-000000000205";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const ARITHMETIC = "Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer.";

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

describe("autonomous colony", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  const authorizer = new Authorizer();
  let checkpointer: Awaited<ReturnType<typeof openCheckpointer>>;

  beforeAll(async () => {
    checkpointer = await openCheckpointer(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await checkpointer.end();
  });

  it("does not generate a goal while autonomy is disabled", async () => {
    await seed(testDb());
    const provider = goalProvider();
    const autonomy = new AutonomyService(persistence, authorizer, objectives());
    const app = await createTestApp();
    const settingsResponse = await app.inject({ method: "GET", url: "/api/v1/autonomy/settings", headers: auth(ADMIN_ID) });
    expect(settingsResponse.statusCode).toBe(200);
    expect((settingsResponse.json() as { enabled: boolean }).enabled).toBe(false);
    const cycle = await autonomy.runCycle(admin(), provider, route);
    expect(cycle.outcome).toBe("disabled");
    expect(provider.requests).toHaveLength(0);
    expect(await autonomy.goals(admin())).toHaveLength(0);
    const deniedCycle = await app.inject({ method: "POST", url: "/api/v1/autonomy/cycles", headers: auth(MATH) });
    const deniedObjective = await app.inject({
      method: "POST",
      url: "/api/v1/objectives",
      headers: auth(MATH),
      payload: { objective: "Replace the colony goal." },
    });
    expect(deniedCycle.statusCode).toBe(403);
    expect(deniedObjective.statusCode).toBe(403);
    await expect(autonomy.runCycle(agent(MATH, MATH_DEPARTMENT), provider, route)).rejects.toMatchObject({ statusCode: 403 });
    await app.close();
  });

  it("selects one evidenced goal and rejects invented evidence, duplicates, pause, and a zero budget", async () => {
    await seed(testDb());
    const autonomy = new AutonomyService(persistence, authorizer, objectives());
    await autonomy.update(admin(), { enabled: true, paused: false, intervalMs: 0, cooldownMs: 0, maxInferenceRequests: 1 });
    const provider = goalProvider();
    const selected = await autonomy.runCycle(admin(), provider, route);
    expect(selected.outcome).toBe("selected");
    expect(provider.requests).toHaveLength(1);
    const goals = await autonomy.goals(admin());
    expect(goals).toHaveLength(1);
    expect(goals[0]?.evidence[0]).toMatch(/^observed: /);
    const objective = await objectives().get(admin(), goals[0]!.objectiveId);
    expect(objective.origin).toBe("autonomous");
    expect(objective.objective).toBe(goals[0]?.description);

    await autonomy.update(admin(), { maxActiveGoals: 2 });
    const duplicate = await autonomy.runCycle(admin(), provider, route);
    expect(duplicate.outcome).toBe("duplicate");
    expect(await autonomy.goals(admin())).toHaveLength(1);
    await autonomy.update(admin(), { maxActiveGoals: 1 });
    expect((await autonomy.runCycle(admin(), provider, route)).outcome).toBe("at_capacity");

    await autonomy.cancel(admin(), goals[0]!.id);
    expect((await objectives().get(admin(), goals[0]!.objectiveId)).status).toBe("cancelled");

    const invented = goalProvider("The colony is failing at physics.");
    const rejected = await autonomy.runCycle(admin(), invented, route);
    expect(rejected.outcome).toBe("rejected_evidence");
    expect(await autonomy.goals(admin())).toHaveLength(1);

    await autonomy.pause(admin());
    const pausedProvider = goalProvider();
    expect((await autonomy.runCycle(admin(), pausedProvider, route)).outcome).toBe("paused");
    expect(pausedProvider.requests).toHaveLength(0);
    await autonomy.resume(admin());
    await autonomy.update(admin(), { maxInferenceRequests: 0 });
    const budgetProvider = goalProvider();
    expect((await autonomy.runCycle(admin(), budgetProvider, route)).outcome).toBe("budget");
    expect(budgetProvider.requests).toHaveLength(0);
  });

  it("lets a department add a subgoal and keeps the colony goal unchanged", async () => {
    await seed(testDb());
    const service = objectives();
    const autonomy = new AutonomyService(persistence, authorizer, service);
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: { objective: "Investigate whether our colony can improve its mathematical reasoning." },
      },
      201,
    );
    const createdObjective = created.objective as { id: string; origin: string; objective: string };
    expect(createdObjective.origin).toBe("human");
    const subgoal = await autonomy.createSubgoal(agent(SCIENCE, SCIENCE_DEPARTMENT), createdObjective.id, {
      description: "Check whether the current symbolic assumptions cover the failed cases.",
      idempotencyKey: "science-subgoal-1",
    });
    const replay = await autonomy.createSubgoal(agent(SCIENCE, SCIENCE_DEPARTMENT), createdObjective.id, {
      description: "A different description must not create a second row.",
      idempotencyKey: "science-subgoal-1",
    });
    expect(replay.id).toBe(subgoal.id);
    await expect(
      autonomy.createSubgoal(agent(SCIENCE, SCIENCE_DEPARTMENT), createdObjective.id, {
        description: createdObjective.objective,
        idempotencyKey: "science-subgoal-2",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await service.get(admin(), createdObjective.id)).objective).toBe(createdObjective.objective);
    await app.close();
  });

  it("still routes a human arithmetic objective directly", async () => {
    await seed(testDb());
    const provider = new ScriptedInferenceProvider((request) => {
      const system = request.messages.map((message) => message.content).join("\n");
      if (system.includes("JSON object") || system.includes("Synthesize")) {
        throw new Error("CEO inference was not expected");
      }
      return observed(request, "17 multiplied by 23 is 391.");
    });
    const service = objectives();
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: ARITHMETIC } },
      201,
    );
    const graph = compileCeoGraph({ service, provider, route, workerId: "ceo-test", checkpointer });
    await runCeoPass(graph, service);
    expect(provider.requests).toHaveLength(0);
    const scheduled = await service.get(admin(), created.objective.id);
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.origin).toBe("human");
    expect(created.objective.id).toBe(scheduled.id);
    const tasks = await service.tasks(admin(), created.objective.id);
    expect(tasks.map((task) => task.departmentSlug)).toEqual(["math"]);
    await app.close();
  });

  it("persists a multi-turn disagreement and enforces conversation bounds", async () => {
    await seed(testDb());
    const memoriesBefore = await persistence.repos.autonomy.countMemories();
    const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
    const provider = speaker();
    const app = await createTestApp();
    const first = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Ask math to examine the assumption.",
      idempotencyKey: "science-question-1",
    });
    const replay = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Ask math to examine the assumption.",
      idempotencyKey: "science-question-1",
    });
    expect(replay.id).toBe(first.id);
    expect(provider.requests).toHaveLength(1);
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, first.conversationId, {
      kind: "disagreement",
      instruction: "Disagree and name the failing case.",
      idempotencyKey: "math-disagree-1",
      parentMessageId: first.messageId,
    });
    await dialogue.speak(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, first.conversationId, {
      kind: "counterargument",
      instruction: "Answer the disagreement.",
      idempotencyKey: "science-counter-1",
      parentMessageId: first.messageId,
    });
    const record = await dialogue.read(admin(), first.conversationId);
    expect(record.turns.map((turn) => `${turn.departmentSlug}:${turn.kind}`)).toEqual([
      "science:question",
      "math:disagreement",
      "science:counterargument",
    ]);
    expect(record.turns[1]?.body).toMatch(/disagree/i);
    expect(record.turns[2]?.parentMessageId).toBe(first.messageId);
    await expect(dialogue.read(agent(RESEARCH, "00000000-0000-4000-8000-000000000018"), first.conversationId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      dialogue.speak(agent(RESEARCH, "00000000-0000-4000-8000-000000000018"), provider, route, first.conversationId, {
        kind: "evidence",
        instruction: "Join without being a participant.",
        idempotencyKey: "research-join-1",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await persistence.repos.autonomy.countMemories()).toBe(memoriesBefore);

    const transcript = await app.inject({
      method: "GET",
      url: `/api/v1/department-conversations/${first.conversationId}`,
      headers: auth(ADMIN_ID),
    });
    expect(transcript.statusCode).toBe(200);
    const body = transcript.json() as { lines: string[] };
    expect(body.lines).toEqual([
      "science (question): Are the current mathematical assumptions adequate?",
      "math (disagreement): I disagree. The model fails when the quantity is zero.",
      "science (counterargument): The zero case is outside the stated domain.",
    ]);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/department-conversations/${first.conversationId}`,
      headers: auth(RESEARCH),
    });
    expect(hidden.statusCode).toBe(403);

    await persistence.repos.autonomy.saveSettings({ maxConversationMessages: 2 });
    const limited = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
    const opened = await limited.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "A short exchange",
      kind: "question",
      instruction: "Ask one question.",
      idempotencyKey: "science-limit-1",
    });
    await limited.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "response",
      instruction: "Answer once.",
      idempotencyKey: "math-limit-1",
    });
    await expect(
      limited.speak(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        kind: "challenge",
        instruction: "Continue past the limit.",
        idempotencyKey: "science-limit-2",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect((await persistence.repos.autonomy.findConversation(opened.conversationId))?.status).toBe("terminated");

    let clock = new Date("2026-01-01T00:00:00.000Z");
    await persistence.repos.autonomy.saveSettings({ maxDurationMs: 1000, maxConversationMessages: 12 });
    const timed = new DialogueService(
      persistence,
      authorizer,
      new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY),
      () => clock,
    );
    const quiet = await timed.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "An inactive exchange",
      kind: "question",
      instruction: "Ask and then wait.",
      idempotencyKey: "science-timeout-1",
    });
    clock = new Date("2026-01-01T00:00:02.000Z");
    expect(await timed.maintain()).toBeGreaterThan(0);
    expect((await persistence.repos.autonomy.findConversation(quiet.conversationId))?.closeReason).toBe("inactivity");
    await app.close();
  });

  function objectives() {
    return new ObjectiveService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
  }
});

function goalProvider(invented?: string) {
  return new ScriptedInferenceProvider((request) => {
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const lines = user.split("\n").map((line) => line.replace(/^- /, "")).filter((line) => line.length > 0);
    const evidence = invented ? `observed: ${invented}` : `observed: ${lines.find((line) => line.startsWith("stored memories:")) ?? lines[0]}`;
    return observed(
      request,
      JSON.stringify({
        goal: "Investigate repeated failed objectives.",
        motivation: "The observation summary records colony state that can be checked.",
        evidence: [evidence],
        hypotheses: ["A shared cause may exist."],
        expectedBenefit: "The colony has a recorded line of inquiry.",
        successCriteria: ["The goal remains tied to the cited observation."],
        estimatedResources: { inferenceRequests: 1 },
        departments: ["reasoning"],
        priority: "low",
        stopConditions: ["The cited observation is no longer present."],
      }),
    );
  });
}

function speaker() {
  const bodies: Partial<Record<DialogueKind, string>> = {
    question: "Are the current mathematical assumptions adequate?",
    disagreement: "I disagree. The model fails when the quantity is zero.",
    counterargument: "The zero case is outside the stated domain.",
    response: "The zero case is a counterexample.",
  };
  return new ScriptedInferenceProvider((request) => {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const kind = (system.match(/Speech act: (\w+)/)?.[1] ?? "response") as DialogueKind;
    return observed(request, bodies[kind] ?? `Turn ${kind}`);
  });
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
    correlationId: "test",
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
    correlationId: "test",
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
