import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
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
import { compileCeoGraph, openCheckpointer, runCeoPass } from "@ai-colony/workflows";
import { ADMIN_ID, auth, createTestApp, expectStatus } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

const MATH = "00000000-0000-4000-8000-000000000204";
const SCIENCE = "00000000-0000-4000-8000-000000000205";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const REASONING = "00000000-0000-4000-8000-000000000207";
const EVALUATION = "00000000-0000-4000-8000-000000000209";
const PRODUCT = "00000000-0000-4000-8000-000000000213";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const RESEARCH_DEPARTMENT = "00000000-0000-4000-8000-000000000018";
const REASONING_DEPARTMENT = "00000000-0000-4000-8000-00000000001a";
const EVALUATION_DEPARTMENT = "00000000-0000-4000-8000-000000000017";
const PRODUCT_DEPARTMENT = "00000000-0000-4000-8000-00000000001d";
const GAMING_DEPARTMENT = "00000000-0000-4000-8000-00000000001c";

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

describe("group conversations", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  const authorizer = new Authorizer();
  let checkpointer: Awaited<ReturnType<typeof openCheckpointer>>;

  beforeAll(async () => {
    checkpointer = await openCheckpointer(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await checkpointer.end();
  });

  it("runs a three-department exchange with directed selection, disagreement, and stored context", async () => {
    await seed(testDb());
    const dialogue = dialogueService();
    const provider = speaker();
    const memoriesBefore = await persistence.repos.autonomy.countMemories();
    const first = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: "group-science-open",
    });
    const speakerChoice = await dialogue.nextSpeaker(agent(SCIENCE, SCIENCE_DEPARTMENT), first.conversationId);
    expect(speakerChoice.speaker).toMatchObject({ departmentId: MATH_DEPARTMENT, slug: "math", reason: "directed" });
    const reply = await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, first.conversationId, {
      kind: "disagreement",
      instruction: "I disagree. The model fails when the quantity is zero.",
      idempotencyKey: "group-math-disagree",
      parentMessageId: first.messageId,
      addressedDepartmentId: SCIENCE_DEPARTMENT,
    });
    expect(reply.prompt.some((message) => message.content.includes("Math, are the current assumptions adequate?"))).toBe(true);
    expect(reply.parentMessageId).toBe(first.messageId);
    await dialogue.invite(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, first.conversationId, {
      departmentId: RESEARCH_DEPARTMENT,
      instruction: "I propose inviting Research for a source check.",
      idempotencyKey: "group-invite-research",
    });
    const beforeAccept = await dialogue.read(agent(RESEARCH, RESEARCH_DEPARTMENT), first.conversationId);
    expect(beforeAccept.transcriptVisible).toBe(false);
    expect(beforeAccept.turns).toHaveLength(0);
    await dialogue.accept(agent(RESEARCH, RESEARCH_DEPARTMENT), first.conversationId);
    await dialogue.speak(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, first.conversationId, {
      kind: "evidence",
      instruction: "The cited result does not cover the zero case.",
      idempotencyKey: "group-research-evidence",
      addressedDepartmentId: null,
    });
    const record = await dialogue.read(admin(), first.conversationId);
    expect(record.turns.map((turn) => `${turn.departmentSlug}:${turn.kind}`)).toEqual([
      "science:question",
      "math:disagreement",
      "science:proposal",
      "research:evidence",
    ]);
    expect(record.activeDepartmentIds).toHaveLength(3);
    expect(record.events.map((event) => event.action)).toEqual(["joined", "joined", "invited", "accepted"]);
    expect(record.turns[3]?.addressedDepartmentSlug).toBeNull();
    expect(record.turns.map((turn) => turn.sequence)).toEqual([1, 2, 3, 4]);
    expect(await persistence.repos.autonomy.countMemories()).toBe(memoriesBefore);
    const replay = await dialogue.speak(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, first.conversationId, {
      kind: "evidence",
      instruction: "The cited result does not cover the zero case.",
      idempotencyKey: "group-research-evidence",
    });
    expect(replay.id).toBe(record.turns[3]?.id);
    expect(provider.requests).toHaveLength(4);

    const app = await createTestApp();
    const transcript = await app.inject({
      method: "GET",
      url: `/api/v1/department-conversations/${first.conversationId}`,
      headers: auth(ADMIN_ID),
    });
    expect(transcript.statusCode).toBe(200);
    const body = transcript.json() as { exchanges: Array<{ from: string; to: string; kind: string }> };
    expect(body.exchanges.map((item) => `${item.from}->${item.to}:${item.kind}`)).toEqual([
      "science->math:question",
      "math->science:disagreement",
      "science->group:proposal",
      "research->group:evidence",
    ]);
    await app.close();
  });

  it("adds a fourth department and rejects a seat past the participant limit", async () => {
    await seed(testDb());
    const dialogue = dialogueService();
    const provider = speaker();
    await persistence.repos.autonomy.saveSettings({ maxConversationParticipants: 3 });
    const opened = await openPair(dialogue, provider, "four");
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "response",
      instruction: "The bound fails at zero.",
      idempotencyKey: "four-math",
    });
    await dialogue.invite(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
      departmentId: RESEARCH_DEPARTMENT,
      instruction: "Invite Research.",
      idempotencyKey: "four-invite-research",
    });
    await dialogue.accept(agent(RESEARCH, RESEARCH_DEPARTMENT), opened.conversationId);
    const before = provider.requests.length;
    await expect(
      dialogue.invite(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, opened.conversationId, {
        departmentId: REASONING_DEPARTMENT,
        instruction: "Invite Reasoning too.",
        idempotencyKey: "four-invite-reasoning",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(provider.requests).toHaveLength(before);
    await persistence.repos.autonomy.saveSettings({ maxConversationParticipants: 4 });
    await dialogue.invite(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, opened.conversationId, {
      departmentId: REASONING_DEPARTMENT,
      instruction: "Invite Reasoning for the contradiction.",
      idempotencyKey: "four-invite-reasoning",
    });
    await dialogue.accept(agent(REASONING, REASONING_DEPARTMENT), opened.conversationId);
    await dialogue.speak(agent(REASONING, REASONING_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "challenge",
      instruction: "Both sides assume the domain was stated.",
      idempotencyKey: "four-reasoning",
      addressedDepartmentId: SCIENCE_DEPARTMENT,
    });
    const record = await dialogue.read(admin(), opened.conversationId);
    expect(record.activeDepartmentIds).toHaveLength(4);
    expect(record.turns.map((turn) => turn.departmentSlug)).toContain("reasoning");
  });

  it("rejects an outsider invitation and an archived department, then hides turns from a removed participant", async () => {
    await seed(testDb());
    const dialogue = dialogueService();
    const provider = speaker();
    const opened = await openPair(dialogue, provider, "remove");
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "response",
      instruction: "Here is the counterexample.",
      idempotencyKey: "remove-math",
    });
    await expect(
      dialogue.invite(agent(PRODUCT, PRODUCT_DEPARTMENT), provider, route, opened.conversationId, {
        departmentId: RESEARCH_DEPARTMENT,
        instruction: "Product is not in this conversation.",
        idempotencyKey: "remove-outsider",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      dialogue.invite(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        departmentId: GAMING_DEPARTMENT,
        instruction: "Invite Gaming.",
        idempotencyKey: "remove-gaming",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await dialogue.invite(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
      departmentId: RESEARCH_DEPARTMENT,
      instruction: "Invite Research.",
      idempotencyKey: "remove-invite",
    });
    await dialogue.accept(agent(RESEARCH, RESEARCH_DEPARTMENT), opened.conversationId);
    await dialogue.invite(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, opened.conversationId, {
      departmentId: EVALUATION_DEPARTMENT,
      instruction: "Invite Evaluation.",
      idempotencyKey: "remove-eval-invite",
    });
    expect((await dialogue.read(agent(EVALUATION, EVALUATION_DEPARTMENT), opened.conversationId)).turns).toHaveLength(0);
    await dialogue.decline(agent(EVALUATION, EVALUATION_DEPARTMENT), opened.conversationId);
    await expect(dialogue.read(agent(EVALUATION, EVALUATION_DEPARTMENT), opened.conversationId)).rejects.toMatchObject({ statusCode: 403 });
    await dialogue.remove(agent(SCIENCE, SCIENCE_DEPARTMENT), opened.conversationId, RESEARCH_DEPARTMENT, "The source check is finished.");
    const later = await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "response",
      instruction: "This follow-up is only for the remaining participants.",
      idempotencyKey: "remove-later",
    });
    const hidden = await dialogue.read(agent(RESEARCH, RESEARCH_DEPARTMENT), opened.conversationId);
    expect(hidden.turns.some((turn) => turn.id === later.id)).toBe(false);
    const full = await dialogue.read(admin(), opened.conversationId);
    expect(full.turns.some((turn) => turn.body === "This follow-up is only for the remaining participants.")).toBe(true);
    await expect(
      dialogue.speak(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, opened.conversationId, {
        kind: "response",
        instruction: "Research tries to speak after removal.",
        idempotencyKey: "remove-speak",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const audits = await persistence.repos.audit.list({
      targetType: "conversation",
      targetId: opened.conversationId,
      limit: 20,
      cursor: null,
    });
    expect(audits.data.map((event) => event.eventType)).toContain("conversation.removed");
  });

  it("keeps one turn under retries, resumes a stored claim, and orders concurrent replies", async () => {
    await seed(testDb());
    const dialogue = dialogueService();
    const provider = speaker();
    const opened = await openPair(dialogue, provider, "retry");
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "response",
      instruction: "First reply.",
      idempotencyKey: "retry-math",
    });
    const calls = provider.requests.length;
    const restarted = dialogueService();
    const replay = await restarted.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "response",
      instruction: "First reply.",
      idempotencyKey: "retry-math",
    });
    expect(replay.body).toBe("First reply.");
    expect(provider.requests).toHaveLength(calls);

    const concurrent = await openPair(dialogue, provider, "concurrent");
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, concurrent.conversationId, {
      kind: "response",
      instruction: "Concurrent setup.",
      idempotencyKey: "concurrent-math",
    });
    await dialogue.invite(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, concurrent.conversationId, {
      departmentId: RESEARCH_DEPARTMENT,
      instruction: "Invite Research for the concurrent check.",
      idempotencyKey: "concurrent-invite",
    });
    await dialogue.accept(agent(RESEARCH, RESEARCH_DEPARTMENT), concurrent.conversationId);
    const [mathTurn, researchTurn] = await Promise.all([
      dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, concurrent.conversationId, {
        kind: "counterargument",
        instruction: "Math concurrent reply.",
        idempotencyKey: "retry-math-concurrent",
      }),
      dialogue.speak(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, concurrent.conversationId, {
        kind: "evidence",
        instruction: "Research concurrent reply.",
        idempotencyKey: "retry-research-concurrent",
      }),
    ]);
    const concurrentRecord = await dialogue.read(admin(), concurrent.conversationId);
    const sequences = concurrentRecord.turns.map((turn) => turn.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(concurrentRecord.turns.map((turn) => turn.body)).toEqual(expect.arrayContaining([mathTurn.body, researchTurn.body]));

    await persistence.repos.autonomy.insertClaim({
      idempotencyKey: "retry-recovered",
      conversationId: opened.conversationId,
      departmentId: MATH_DEPARTMENT,
      kind: "response",
      addressedDepartmentId: null,
      parentMessageId: null,
      sequence: 20,
      body: "Recovered from the stored claim.",
      prompt: [{ role: "system", content: "stored" }],
      inputTokens: 1,
      outputTokens: 1,
    });
    const failing = new ScriptedInferenceProvider(() => {
      throw new Error("restart should not generate");
    });
    const recovered = await dialogue.speak(agent(MATH, MATH_DEPARTMENT), failing, route, opened.conversationId, {
      kind: "response",
      instruction: "This should not be generated.",
      idempotencyKey: "retry-recovered",
    });
    expect(recovered.body).toBe("Recovered from the stored claim.");
    expect(failing.requests).toHaveLength(0);
  });

  it("closes on a repeated turn, an unresolved ending, a message limit, and an administrator termination", async () => {
    await seed(testDb());
    const dialogue = dialogueService();
    const provider = speaker();
    const opened = await openPair(dialogue, provider, "close");
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, opened.conversationId, {
      kind: "disagreement",
      instruction: "I disagree with the stated domain.",
      idempotencyKey: "close-disagree",
    });
    await expect(
      dialogue.speak(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        kind: "question",
        instruction: "Math, are the current assumptions adequate?",
        idempotencyKey: "close-loop",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect((await persistence.repos.autonomy.findConversation(opened.conversationId))?.closeReason).toBe("loop");

    const unresolved = await openPair(dialogue, provider, "unresolved");
    await dialogue.speak(agent(MATH, MATH_DEPARTMENT), provider, route, unresolved.conversationId, {
      kind: "disagreement",
      instruction: "The disagreement remains.",
      idempotencyKey: "unresolved-disagree",
    });
    await dialogue.speak(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, unresolved.conversationId, {
      kind: "close",
      instruction: "Stop without agreement.",
      idempotencyKey: "unresolved-close",
    });
    const closed = await persistence.repos.autonomy.findConversation(unresolved.conversationId);
    expect(closed?.status).toBe("unresolved");
    expect(closed?.remainingDisagreements.some((line) => line.includes("The disagreement remains."))).toBe(true);
    expect(closed?.finalConclusion).toBeNull();

    await persistence.repos.autonomy.saveSettings({ maxConversationMessages: 2 });
    const limited = dialogueService();
    const short = await openPair(limited, provider, "budget");
    await limited.speak(agent(MATH, MATH_DEPARTMENT), provider, route, short.conversationId, {
      kind: "response",
      instruction: "One reply.",
      idempotencyKey: "budget-math",
    });
    await expect(
      limited.speak(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, short.conversationId, {
        kind: "challenge",
        instruction: "Past the limit.",
        idempotencyKey: "budget-over",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await persistence.repos.autonomy.findConversation(short.conversationId))?.closeReason).toBe("message_limit");

    await persistence.repos.autonomy.saveSettings({ maxConversationMessages: 12 });
    const managed = await openPair(dialogueService(), provider, "admin");
    await expect(
      dialogueService().terminate(agent(SCIENCE, SCIENCE_DEPARTMENT), managed.conversationId, "A participant tries to override the administrator."),
    ).rejects.toMatchObject({ statusCode: 403 });
    const terminated = await dialogueService().terminate(admin(), managed.conversationId, "Administrator stop.");
    expect(terminated.status).toBe("terminated");
    expect(terminated.closeReason).toBe("Administrator stop.");
    await expect(
      dialogueService().speak(agent(MATH, MATH_DEPARTMENT), provider, route, managed.conversationId, {
        kind: "response",
        instruction: "After termination.",
        idempotencyKey: "admin-after",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await persistence.repos.autonomy.findConversation(managed.conversationId))?.status).toBe("terminated");
  });

  it("preserves direct routing, human objectives, disabled goal generation, and objective cancellation", async () => {
    await seed(testDb());
    const autonomy = new AutonomyService(persistence, authorizer, objectives());
    const provider = new ScriptedInferenceProvider((request) => observed(request, "unused"));
    expect((await autonomy.runCycle(admin(), provider, route)).outcome).toBe("disabled");
    expect(provider.requests).toHaveLength(0);

    const app = await createTestApp();
    const created = await expectStatus(
      app,
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: { objective: "Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer." },
      },
      201,
    );
    const graph = compileCeoGraph({ service: objectives(), provider, route, workerId: "ceo-group", checkpointer });
    await runCeoPass(graph, objectives());
    const objective = await persistence.repos.objectives.getRun(created.objective.id);
    expect(objective?.origin).toBe("human");
    expect(objective?.executionPath).toBe("direct");
    await expect(
      dialogueService().open(agent(SCIENCE, SCIENCE_DEPARTMENT), speaker(), route, {
        recipientDepartmentId: MATH_DEPARTMENT,
        topic: "Do not collaborate on arithmetic",
        objectiveId: created.objective.id,
        kind: "question",
        instruction: "Open a group anyway.",
        idempotencyKey: "direct-open",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(provider.requests).toHaveLength(0);

    const collaborative = await expectStatus(
      app,
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: { objective: "Help me figure out what the colony should do next." },
      },
      201,
    );
    const conversation = await dialogueService().open(agent(SCIENCE, SCIENCE_DEPARTMENT), speaker(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Which gap should we inspect?",
      objectiveId: collaborative.objective.id,
      kind: "question",
      instruction: "The colony goal is still open.",
      idempotencyKey: "objective-open",
    });
    expect(conversation.prompt.some((message) => message.content.includes("Help me figure out what the colony should do next."))).toBe(true);
    await objectives().cancel(admin(), collaborative.objective.id);
    expect(await dialogueService().maintain()).toBeGreaterThan(0);
    expect((await persistence.repos.autonomy.findConversation(conversation.conversationId))?.closeReason).toBe("objective_cancelled");
    await app.close();
  });

  function dialogueService() {
    return new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
  }

  function objectives() {
    return new ObjectiveService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
  }

  async function openPair(dialogue: DialogueService, provider: ScriptedInferenceProvider, key: string) {
    return dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Math, are the current assumptions adequate?",
      idempotencyKey: `${key}-open`,
    });
  }
});

function speaker() {
  return new ScriptedInferenceProvider((request) => {
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const instruction = user.match(/Instruction: ([^\n]+)/)?.[1] ?? "Turn";
    return observed(request, instruction);
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
