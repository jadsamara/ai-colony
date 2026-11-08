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
let now = Date.parse("2026-06-09T00:00:00.000Z");

describe("C1.7.4 Phase B automatic claim extraction", () => {
  it("extracts spacecraft claims from an accepted turn, verifies masses, and refutes ion>chemical", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, claims } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "response",
        body: "With dry mass 1000 kg and delta-v 3000 m/s, chemical Isp 350 s requires about 1396 kg of propellant, ion Isp 3000 s needs about 107 kg propellant, and ion propulsion needs more propellant than chemical.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Spacecraft propellant comparison",
      kind: "question",
      instruction: "Compare chemical and ion propellant mass.",
      idempotencyKey: "c174b-open-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const listed = await claims.listClaims(admin(), opened.conversationId);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.some((row) => row.verificationStatus === "verified")).toBe(true);
    expect(listed.some((row) => row.verificationStatus === "refuted")).toBe(true);
    expect(listed.every((row) => row.supportingTurnId !== null)).toBe(true);
    expect(listed.every((row) => row.idempotencyKey !== null)).toBe(true);
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    expect(stored?.progressState.refutedClaimNotices.some((notice) => notice.includes("Independent verification result"))).toBe(true);
    expect(stored?.progressState.failedGenerations).toEqual([]);
  });

  it("is idempotent across runner resume of the same accepted turn key", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, claims } = services();
    const body = JSON.stringify({
      kind: "response",
      body: "Dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s requires about 1396 kg of propellant.",
      decision: "speak",
    });
    const provider = outputsProvider([body, body]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Idempotent claim capture",
      kind: "question",
      instruction: "State the chemical propellant mass.",
      idempotencyKey: "c174b-open-0002",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const first = await claims.listClaims(admin(), opened.conversationId);
    expect(first.length).toBeGreaterThanOrEqual(1);
    const turn = (await persistence.repos.autonomy.listTurns(opened.conversationId)).find((row) =>
      row.body.includes("1396"),
    );
    expect(turn).toBeTruthy();
    const again = await claims.captureTurnClaims(admin(), {
      conversationId: opened.conversationId,
      turnId: turn!.id,
      proposingDepartmentId: MATH_DEPARTMENT,
      body: turn!.body,
    });
    expect(again.created).toBe(0);
    expect(again.skipped).toBeGreaterThanOrEqual(1);
    const second = await claims.listClaims(admin(), opened.conversationId);
    expect(second).toHaveLength(first.length);
  });

  it("keeps unsupported numerical statements inconclusive and does not invent assumptions", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, claims } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "response",
        body: "The propellant mass is about 1396 kg.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Unsupported propellant claim",
      kind: "question",
      instruction: "State a propellant mass without assumptions.",
      idempotencyKey: "c174b-open-0003",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const listed = await claims.listClaims(admin(), opened.conversationId);
    expect(listed.some((row) => row.verificationStatus === "inconclusive")).toBe(true);
    expect(listed.every((row) => row.verificationStatus !== "verified")).toBe(true);
  });

  it("treats verification-service failures as nonfatal and preserves conversation progress", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "response",
        body: "Dry mass 1000 kg, delta-v 3000 m/s, chemical Isp 350 s requires about 1396 kg of propellant.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Nonfatal claim failure",
      kind: "question",
      instruction: "State a propellant mass.",
      idempotencyKey: "c174b-open-0004",
    });
    const original = persistence.repos.claims.insertClaimIdempotent.bind(persistence.repos.claims);
    persistence.repos.claims.insertClaimIdempotent = async () => {
      throw new Error("simulated claim repository failure");
    };
    try {
      await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    } finally {
      persistence.repos.claims.insertClaimIdempotent = original;
    }
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    expect(turns.some((turn) => turn.body.includes("1396"))).toBe(true);
    expect(stored?.status).toBe("open");
    expect(stored?.progressState.claimCaptureFailures).toBeGreaterThanOrEqual(1);
    expect(stored?.progressState.lastClaimCaptureError).toContain("simulated claim repository failure");
  });

  it("surfaces refuted-claim notices in the next department prompt without rewriting history", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({
        kind: "response",
        body: "Dry mass 1000 kg and delta-v 3000 m/s with chemical Isp 350 s and ion Isp 3000 s. Ion propulsion needs more propellant than chemical.",
        decision: "speak",
      }),
      JSON.stringify({
        kind: "challenge",
        body: "The ion-more-propellant claim is disputed by independent calculation.",
        decision: "speak",
      }),
    ]);
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Challenge refuted claim",
      kind: "question",
      instruction: "Evaluate the ion versus chemical claim.",
      idempotencyKey: "c174b-open-0005",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 2 });
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    const original = turns.find((turn) => /needs more propellant than chemical/i.test(turn.body));
    expect(original).toBeTruthy();
    const followUpPrompt = turns.find((turn) => turn.body.includes("disputed by independent calculation"))?.prompt
      .map((message) => message.content)
      .join("\n") ?? "";
    expect(followUpPrompt).toContain("Independent verification result");
    expect(original!.body).toMatch(/needs more propellant than chemical/i);
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

async function enable() {
  now = Date.parse("2026-06-09T00:00:00.000Z");
  await persistence.repos.autonomy.saveSettings({
    conversationExecutionEnabled: true,
    maxConcurrentConversationTurns: 1,
    maxConversationMessages: 12,
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
    correlationId: "c174b",
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
    correlationId: "c174b",
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
