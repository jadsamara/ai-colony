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
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const EVALUATION = "00000000-0000-4000-8000-000000000209";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const REASONING_DEPARTMENT = "00000000-0000-4000-8000-00000000001a";
const RESEARCH_DEPARTMENT = "00000000-0000-4000-8000-000000000018";
const WEIGHT_DEPARTMENT = "00000000-0000-4000-8000-000000000015";
const MEMORY_DEPARTMENT = "00000000-0000-4000-8000-000000000016";
const EVALUATION_DEPARTMENT = "00000000-0000-4000-8000-000000000017";
const ORCHESTRATION_DEPARTMENT = "00000000-0000-4000-8000-000000000012";
const CEO_DEPARTMENT = "00000000-0000-4000-8000-000000000011";
const MONITORING_DEPARTMENT = "00000000-0000-4000-8000-000000000013";
const EVOLUTION_DEPARTMENT = "00000000-0000-4000-8000-000000000014";
const PRODUCT_DEPARTMENT = "00000000-0000-4000-8000-00000000001d";
const GAMING_DEPARTMENT = "00000000-0000-4000-8000-00000000001c";

const EIGHT = [
  REASONING_DEPARTMENT,
  RESEARCH_DEPARTMENT,
  WEIGHT_DEPARTMENT,
  MEMORY_DEPARTMENT,
  EVALUATION_DEPARTMENT,
  ORCHESTRATION_DEPARTMENT,
];
const TWELVE = [
  ...EIGHT,
  CEO_DEPARTMENT,
  MONITORING_DEPARTMENT,
  EVOLUTION_DEPARTMENT,
  PRODUCT_DEPARTMENT,
];

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

describe("governed multi-department conversations", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  let now = Date.parse("2026-06-01T00:00:00.000Z");

  it("seats 2, 4, 8, and 12 active departments and keeps Gaming archived", async () => {
    await seed(testDb());
    const { dialogue } = services(now);
    const provider = scripted();
    const two = await open(dialogue, provider, "governed-two", []);
    const four = await open(dialogue, provider, "governed-four", [REASONING_DEPARTMENT, RESEARCH_DEPARTMENT]);
    const eight = await open(dialogue, provider, "governed-eight", EIGHT);
    const twelve = await open(dialogue, provider, "governed-twelve", TWELVE);
    expect(await activeRoles(two)).toHaveLength(2);
    expect(await activeRoles(four)).toHaveLength(4);
    expect(await activeRoles(eight)).toHaveLength(8);
    const seated = await activeRoles(twelve);
    expect(seated).toHaveLength(12);
    expect(seated.map((item) => item.departmentId)).not.toContain(GAMING_DEPARTMENT);
    expect(seated.find((item) => item.departmentId === SCIENCE_DEPARTMENT)).toMatchObject({ role: "opener", joinSequence: 1, invitedByDepartmentId: null });
    expect(seated.find((item) => item.departmentId === MATH_DEPARTMENT)).toMatchObject({ role: "participant", joinSequence: 2, invitedByDepartmentId: SCIENCE_DEPARTMENT });
    expect(seated.find((item) => item.departmentId === EVALUATION_DEPARTMENT)).toMatchObject({ role: "evaluator", invitedByDepartmentId: SCIENCE_DEPARTMENT });
    expect(seated.map((item) => item.joinSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(open(dialogue, provider, "governed-gaming", [GAMING_DEPARTMENT])).rejects.toMatchObject({ statusCode: 409 });
    await expect(open(dialogue, provider, "governed-duplicate", [MATH_DEPARTMENT])).rejects.toMatchObject({ statusCode: 422 });
    await expect(open(dialogue, provider, "governed-missing", ["00000000-0000-4000-8000-0000000000ff"])).rejects.toMatchObject({ statusCode: 422 });
    await expect(dialogue.open(observer(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "continual learning",
      kind: "question",
      instruction: "Math, estimate the gain.",
      idempotencyKey: "governed-observer",
    })).rejects.toMatchObject({ statusCode: 403 });
    expect((await persistence.repos.autonomy.settings()).enabled).toBe(false);
    const gaming = await persistence.repos.autonomy.department(GAMING_DEPARTMENT);
    expect(gaming?.status).toBe("archived");
  });

  it("recommends a speaker, keeps an evaluation from closing the conversation, and resumes after a pause", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({
      conversationExecutionEnabled: true,
      conversationCheckpointTurns: 2,
      conversationSoftTokenBudget: 20_000,
      conversationHardTokenCeiling: 60_000,
      maxConversationMessages: 30,
      maxConcurrentConversationTurns: 1,
      contextTokenBudget: 1_500,
    });
    const { dialogue, runner } = services(now);
    const provider = scripted();
    const id = await open(dialogue, provider, "governed-learning", EIGHT);
    const assessment = await dialogue.speak(agent(EVALUATION, EVALUATION_DEPARTMENT), provider, route, id, {
      kind: "close",
      instruction: "Evaluation records that autonomous improvement is still unproven.",
      idempotencyKey: "governed-evaluation",
      prepared: {
        body: "Evaluation records that autonomous improvement is still unproven.",
        prompt: [],
        inputTokens: 8,
        outputTokens: 12,
      },
    });
    expect(assessment.kind).toBe("response");
    expect(assessment.departmentSlug).toBe("evaluation");
    expect((await persistence.repos.autonomy.findConversation(id))?.status).toBe("open");
    const before = await dialogue.read(admin(), id);
    await runner.run(admin(), id, provider, route, { maxTurns: 2 });
    const checkpoint = await persistence.repos.autonomy.findConversation(id);
    expect(checkpoint?.status).toBe("open");
    expect(checkpoint?.progressState.lastDecision).toBe("continue");
    expect(checkpoint?.progressState.byDepartment.science?.questions).toBeGreaterThan(0);
    expect(checkpoint?.recommendedSpeakerId).toBeTruthy();
    expect(checkpoint?.speakerRecommendationReason).toBeTruthy();
    const recommendation = await dialogue.nextSpeaker(admin(), id);
    expect(recommendation.source).toBe("orchestration");
    expect(recommendation.speaker?.departmentId).toBeTruthy();
    await runner.pause(admin(), id);
    await runner.resume(admin(), id);
    await runner.run(admin(), id, provider, route, { maxTurns: 1 });
    const resumed = await dialogue.read(admin(), id);
    expect(resumed.conversation.status).toBe("open");
    expect(resumed.conversation.paused).toBe(false);
    expect(resumed.turns.length).toBeGreaterThan(before.turns.length);
    expect(resumed.turns.some((turn) => turn.body === before.turns[0]?.body)).toBe(true);
    expect((await persistence.repos.autonomy.settings()).enabled).toBe(false);
  });

  it("routes the speaking department to its own endpoint", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ conversationExecutionEnabled: true, maxConcurrentConversationTurns: 1 });
    const { dialogue, runner } = services(now);
    const shared = scripted();
    const math = counting("The math estimate is 4.");
    const science = counting("Science should not answer this turn.");
    const id = await open(dialogue, shared, "governed-route", []);
    await runner.run(admin(), id, shared, {
      ...route,
      dedicatedRouting: {
        enabled: true,
        instances: [serving("math", MATH_DEPARTMENT, "http://ollama-math:11434"), serving("science", SCIENCE_DEPARTMENT, "http://ollama-science:11434")],
        providerFor: (instanceId) => instanceId === "math-instance" ? math.provider : instanceId === "science-instance" ? science.provider : null,
      },
    }, { maxTurns: 1 });
    expect(math.calls).toBeGreaterThan(0);
    expect(science.calls).toBe(0);
    const stored = await persistence.repos.autonomy.findConversation(id);
    expect(stored?.lastInferenceEndpoint).toContain("http://ollama-math:11434");
    expect(stored?.lastInferenceEndpoint).not.toContain("ollama-science");
  });
});

async function open(dialogue: DialogueService, provider: ScriptedInferenceProvider, key: string, participantDepartmentIds: string[]) {
  const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
    recipientDepartmentId: MATH_DEPARTMENT,
    participantDepartmentIds,
    topic: "How should the colony investigate continual learning and autonomous model improvement?",
    kind: "question",
    instruction: "Math, estimate whether the current evidence supports a gain.",
    idempotencyKey: key,
  });
  return opened.conversationId;
}

async function activeRoles(conversationId: string) {
  const persistence = createPersistence(testDb(), async () => undefined);
  const rows = await persistence.repos.autonomy.listMembership(conversationId);
  return rows.filter((row) => row.membership === "active").sort((left, right) => left.joinSequence - right.joinSequence);
}

function services(now: number) {
  const persistence = createPersistence(testDb(), async () => undefined);
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY), () => new Date(now));
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now), undefined, 1_000);
  return { dialogue, runner };
}

function scripted() {
  let count = 0;
  return new ScriptedInferenceProvider((request) => {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    if (!system.includes("Return one JSON object")) {
      const user = request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
      const instruction = user.match(/Instruction: ([^\n]+)/)?.[1] ?? "Turn";
      return observed(request, instruction);
    }
    count += 1;
    return observed(request, JSON.stringify({ kind: "response", body: `Contribution ${count} adds a new calculation for continual learning.`, decision: "speak" }));
  });
}

function counting(body: string) {
  const state = { calls: 0 };
  const provider: InferenceProvider = {
    async generate(request) {
      state.calls += 1;
      return observed(request, JSON.stringify({ kind: "response", body, decision: "speak" }));
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
  return { provider, get calls() { return state.calls; } };
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
    correlationId: "governed",
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

function observer(): RequestContext {
  return {
    correlationId: "governed",
    actor: {
      principalId: "00000000-0000-4000-8000-000000000099",
      principalType: "system",
      role: "read_only_observer",
      agentId: null,
      departmentId: null,
      permissions: [],
    },
  };
}

function agent(id: string, departmentId: string): RequestContext {
  return {
    correlationId: "governed",
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
