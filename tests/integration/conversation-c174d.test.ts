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
let now = Date.parse("2026-06-11T00:00:00.000Z");

describe("C1.7.4D structured output reliability", () => {
  it("recovers from malformed JSON within the correction budget and requests jsonSchema", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      "not-json-malformed",
      '{"kind":"response","body":"Recovered contribution after malformed JSON.", "decision":"speak"}',
    ]);
    const conversationId = await openConversation(dialogue, provider, "c174d-malformed");
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    expect(stored?.status).toBe("open");
    expect(stored?.closeReason).toBeNull();
    expect(stored?.progressState.failedGenerations.some((row) => row.failureClass === "json_invalid")).toBe(true);
    expect(stored?.progressState.failedGenerations.every((row) => (row.outputDigest?.length ?? 0) <= 96)).toBe(true);
    const turns = await dialogue.read(admin(), conversationId);
    expect(turns.turns.some((turn) => turn.body.includes("Recovered contribution"))).toBe(true);
    expect(provider.requests.some((request) => request.jsonObject && request.jsonSchema)).toBe(true);
  });

  it("rejects valid JSON with the wrong schema and does not accept the turn", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      JSON.stringify({ kind: "essay", body: "Wrong schema essay body that must not be accepted." }),
      JSON.stringify({ kind: "analysis", body: "Still wrong schema analysis body." }),
      JSON.stringify({ kind: "statement", body: "Third wrong schema statement." }),
      JSON.stringify({ kind: "response", body: "should never be stored as a turn", decision: "speak" }),
    ]);
    const conversationId = await openConversation(dialogue, provider, "c174d-schema");
    const prior = (await dialogue.read(admin(), conversationId)).turns.length;
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    const turns = await dialogue.read(admin(), conversationId);
    expect(stored?.status).toBe("terminated");
    expect(stored?.closeReason).toBe("model_invalid");
    expect(turns.turns).toHaveLength(prior);
    expect(turns.turns.every((turn) => !turn.body.includes("should never be stored"))).toBe(true);
    expect(stored?.progressState.failedGenerations.some((row) => row.failureClass === "schema_invalid")).toBe(true);
    expect(provider.requests.filter((request) => request.messages.some((message) => message.content.includes("Return one JSON object")))).toHaveLength(
      MAX_INVALID_CORRECTIONS + 1,
    );
  });

  it("classifies truncated responses as json/truncated failures without accepting them", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const provider = outputsProvider([
      '{"kind":"response","body":"truncated mid-string',
      '{"kind":"response","body":"still truncated',
      '{"kind":"response","body":"third truncated',
    ]);
    const conversationId = await openConversation(dialogue, provider, "c174d-trunc");
    await runner.run(admin(), conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(conversationId);
    expect(stored?.status).toBe("terminated");
    expect(stored?.closeReason).toBe("model_invalid");
    expect(stored?.lastError).toMatch(/truncated|not valid JSON|not a JSON object/i);
    expect(stored?.progressState.failedGenerations.every((row) => row.failureClass === "json_invalid")).toBe(true);
  });

  it("keeps repeated valid content on the repetition path, not json_invalid", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const repeated = "The zero case remains inadequate under the stated domain assumptions for math review.";
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), outputsProvider([]), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Assumptions",
      kind: "question",
      instruction: repeated,
      idempotencyKey: "c174d-repeat-open",
    });
    const provider = outputsProvider([
      JSON.stringify({ kind: "proposal", body: repeated, decision: "speak" }),
      JSON.stringify({ kind: "proposal", body: repeated, decision: "speak" }),
    ]);
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    const failed = stored?.progressState.failedGenerations ?? [];
    expect(failed.some((row) => row.reason === "repetitive" || row.failureClass === "repetition")).toBe(true);
    expect(failed.every((row) => row.failureClass !== "json_invalid")).toBe(true);
    const turns = await dialogue.read(admin(), opened.conversationId);
    expect(turns.turns.filter((turn) => turn.body === repeated)).toHaveLength(1);
  });

  it("recovers after invalid_after_repetition-style JSON failure on the correction path only when schema-valid", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner } = services();
    const priorBody = "Prior transcript body that the model might echo incorrectly.";
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), outputsProvider([]), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Assumptions",
      kind: "question",
      instruction: priorBody,
      idempotencyKey: "c174d-rep-json-open",
    });
    const provider = outputsProvider([
      JSON.stringify({ kind: "proposal", body: priorBody, decision: "speak" }),
      "totally-not-json-after-repetition-correction",
      JSON.stringify({ kind: "response", body: "Fresh non-repetitive contribution after JSON repair.", decision: "speak" }),
    ]);
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 1 });
    const stored = await persistence.repos.autonomy.findConversation(opened.conversationId);
    // Either recovered into a turn, or terminated model_invalid — never accept the invalid JSON blob.
    const turns = await dialogue.read(admin(), opened.conversationId);
    expect(turns.turns.every((turn) => turn.body !== "totally-not-json-after-repetition-correction")).toBe(true);
    if (stored?.status === "terminated") {
      expect(stored.closeReason).toBe("model_invalid");
      expect(stored.progressState.failedGenerations.some((row) => row.reason === "invalid_after_repetition")).toBe(true);
      expect(stored.progressState.failedGenerations.some((row) => row.failureClass === "json_invalid")).toBe(true);
    } else {
      expect(turns.turns.some((turn) => turn.body.includes("Fresh non-repetitive contribution"))).toBe(true);
    }
  });
});

function services() {
  const authorizer = new Authorizer();
  const dialogue = new DialogueService(
    persistence,
    authorizer,
    new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY),
    () => new Date((now += 1000)),
  );
  const evidence = new TrainingEvidenceService(persistence, authorizer, undefined, () => new Date((now += 1000)));
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date((now += 1000)), undefined, 1000);
  return { dialogue, runner, evidence };
}

async function enable() {
  now = Date.parse("2026-06-11T00:00:00.000Z");
  await persistence.repos.autonomy.saveSettings({
    conversationExecutionEnabled: true,
    maxConcurrentConversationTurns: 1,
    maxConversationMessages: 12,
    conversationCheckpointTurns: 10,
    conversationSoftTokenBudget: 20_000,
    conversationHardTokenCeiling: 60_000,
  });
}

async function openConversation(dialogue: DialogueService, provider: InferenceProvider, key: string) {
  const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, {
    recipientDepartmentId: MATH_DEPARTMENT,
    topic: "Are the current mathematical assumptions adequate?",
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
    correlationId: "c174d",
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
    correlationId: "c174d",
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
