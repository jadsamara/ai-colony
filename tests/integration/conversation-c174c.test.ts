import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  ClaimVerificationService,
  ConversationRunner,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  MessagingService,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const REASONING_DEPARTMENT = "00000000-0000-4000-8000-00000000001a";

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
let now = Date.parse("2026-06-10T00:00:00.000Z");

const SPACECRAFT_INSTRUCTION =
  "Compare chemical and ion propellant mass for a spacecraft with dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s, ion Isp 3000 s. Include thrust/duration tradeoff, assumptions, and a final comparison.";

describe("C1.7.4 Phase C evidence-driven orchestration", () => {
  it("tracks spacecraft deliverables, verifies ~1396/~107 kg, and routes Math when calculation is missing", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, claims } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "response",
        body: "Assumptions: dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s, ion Isp 3000 s. Thrust/duration tradeoff: ion has lower thrust and longer burn duration than chemical.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Spacecraft propellant comparison",
      kind: "question",
      instruction: SPACECRAFT_INSTRUCTION,
      idempotencyKey: "c174c-open-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const afterAssumptions = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(afterAssumptions?.progressState.deliverableParseStatus).toBe("derived");
    expect(afterAssumptions?.progressState.deliverables.some((item) => item.id === "chemical_propellant_mass" && item.status === "open")).toBe(true);
    expect(afterAssumptions?.speakerRecommendationReason).toMatch(/deliverable:chemical_propellant_mass|deliverable:ion_propellant_mass|math/i);

    const calcProvider = outputsProvider([
      JSON.stringify({
        kind: "evidence",
        body: "With dry mass 1000 kg and delta-v 3000 m/s, chemical Isp 350 s requires about 1396 kg of propellant, while ion Isp 3000 s needs about 107 kg propellant. Ion uses less propellant than chemical.",
        decision: "speak",
      }),
    ]);
    await runner.run(admin(), opened.conversationId, calcProvider, route, { maxTurns: 1 });
    const listed = await claims.listClaims(admin(), opened.conversationId);
    expect(listed.some((row) => row.verificationStatus === "verified" && /1396/.test(row.claimText + (row.normalizedExpression ?? "")))).toBe(true);
    expect(listed.some((row) => row.verificationStatus === "verified" && /107/.test(row.claimText + (row.normalizedExpression ?? "")))).toBe(true);
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(stored?.progressState.deliverables.find((item) => item.id === "chemical_propellant_mass")?.status).toBe("verified");
    expect(stored?.progressState.deliverables.find((item) => item.id === "ion_propellant_mass")?.status).toBe("verified");
    expect(stored?.progressState.substantialProgress).toBe(true);
  });

  it("rejects the false ion>chemical comparison and requires an explicit correction", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "response",
        body: "Dry mass 1000 kg and delta-v 3000 m/s with chemical Isp 350 s and ion Isp 3000 s. Ion propulsion needs more propellant than chemical.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "False ion comparison",
      kind: "question",
      instruction: SPACECRAFT_INSTRUCTION,
      idempotencyKey: "c174c-open-0002",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(stored?.progressState.refutedClaimNotices.some((notice) => /Independent verification/i.test(notice))).toBe(true);
    expect(stored?.progressState.pendingCorrections.some((item) => /Correct deliverable/i.test(item))).toBe(true);
    expect(stored?.progressState.deliverables.find((item) => item.id === "final_comparison")?.status).toBe("refuted");
  });

  it("does not close successfully when claims are incomplete or contradicted", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "resolution",
        body: "We conclude ion is preferable without calculating propellant mass.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Premature conclusion",
      kind: "question",
      instruction: SPACECRAFT_INSTRUCTION,
      idempotencyKey: "c174c-open-0003",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(stored?.status).toBe("open");
    expect(stored?.finalConclusion).toBeNull();
    expect(turns.some((turn) => turn.kind === "resolution")).toBe(false);
    expect(turns.some((turn) => turn.body.includes("without calculating"))).toBe(true);
  });

  it("closes successfully only with a consistent evidence-backed final conclusion", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), outputsProvider([]), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Verified spacecraft conclusion",
      kind: "question",
      instruction: SPACECRAFT_INSTRUCTION,
      idempotencyKey: "c174c-open-0004",
      participantDepartmentIds: [REASONING_DEPARTMENT],
    });
    const evidenceProvider = outputsProvider([
      JSON.stringify({
        kind: "evidence",
        body: "Assumptions: dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s, ion Isp 3000 s. Thrust/duration tradeoff: ion thrust is lower and burn duration longer. Chemical propellant mass is about 1396 kg; ion propellant mass is about 107 kg. Ion uses less propellant than chemical.",
        decision: "speak",
      }),
    ]);
    await runner.run(admin(), opened.conversationId, evidenceProvider, route, { maxTurns: 1 });
    const mid = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(mid?.progressState.deliverables.filter((item) => item.status === "verified").length).toBeGreaterThanOrEqual(2);

    const conclusionProvider = outputsProvider([
      JSON.stringify({
        kind: "resolution",
        body: "Final comparison: chemical needs about 1396 kg propellant and ion needs about 107 kg; ion uses less propellant. Thrust/duration tradeoff remains: ion is lower thrust and longer duration. Assumptions were dry mass 1000 kg, delta-v 3000 m/s, Isp 350/3000 s.",
        decision: "speak",
      }),
    ]);
    await runner.run(admin(), opened.conversationId, conclusionProvider, route, { maxTurns: 1 });
    const closed = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(closed?.status).toBe("resolved");
    expect(closed?.outcome).toBe("resolved");
    expect(closed?.finalConclusion).toMatch(/1396/);
    expect(closed?.finalConclusion).toMatch(/107/);
    expect(closed?.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("respects budgets and does not silently increase them; interruption resume stays idempotent", async () => {
    await seed(testDb());
    await enable({ maxMessages: 4 });
    const { dialogue, runner } = services();
    const body = JSON.stringify({
      kind: "response",
      body: "Assumptions restated: dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s.",
      decision: "speak",
    });
    const provider = outputsProvider([body, body, body, body, body]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Budget and resume",
      kind: "question",
      instruction: SPACECRAFT_INSTRUCTION,
      idempotencyKey: "c174c-open-0005",
    });
    const before = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(before?.maxMessages).toBe(4);
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 2 });
    const mid = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(mid?.maxMessages).toBe(4);
    expect(mid?.maxTokens).toBe(before?.maxTokens);
    const turnCount = (await persistence.repos.autonomy.listTurns(opened.conversationId)).length;
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 2 });
    const again = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(again.length).toBeGreaterThanOrEqual(turnCount);
    const after = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(after?.maxMessages).toBe(4);
  });
});

function services() {
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(
    persistence,
    authorizer,
    new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY),
    () => new Date(now += 1000),
  );
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now += 1000), undefined, 1000);
  const claims = new ClaimVerificationService(persistence, authorizer, () => new Date(now += 1000));
  return { dialogue, runner, claims };
}

async function enable(overrides: { maxMessages?: number } = {}) {
  now = Date.parse("2026-06-10T00:00:00.000Z");
  await persistence.repos.autonomy.saveSettings({
    conversationExecutionEnabled: true,
    maxConcurrentConversationTurns: 1,
    maxConversationMessages: overrides.maxMessages ?? 12,
    conversationCheckpointTurns: 10,
    conversationSoftTokenBudget: 20_000,
    conversationHardTokenCeiling: 60_000,
  });
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
    correlationId: "c174c",
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
    correlationId: "c174c",
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
