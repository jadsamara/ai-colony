import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  ConversationRunner,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  MessagingService,
  TrainingEvidenceService,
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
const INSTRUCTION = "Independently evaluate continual-learning methods. Challenge unsupported mathematical claims.";
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
let now = Date.parse("2026-06-05T00:00:00.000Z");

describe("C1.6 training evidence registry", () => {
  it("records accepted and rejected attempts without putting rejects into conversation_turns", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = recoveringProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Can neural networks learn continuously without catastrophic forgetting?",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c16-recover-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 3 });
    const turns = await persistence.repos.autonomy.listTurns(opened.conversationId);
    const listed = await evidence.listAttempts(admin(), { conversationId: opened.conversationId, limit: 50 });
    expect(listed.total).toBeGreaterThan(0);
    expect(listed.data.some((row) => row.acceptanceStatus === "rejected")).toBe(true);
    expect(listed.data.some((row) => row.acceptanceStatus === "accepted" || row.acceptanceStatus === "recovered" || row.acceptanceStatus === "partial")).toBe(true);
    expect(listed.data.every((row) => row.trainingEligible === false)).toBe(true);
    expect(listed.data.every((row) => row.eligibilityStatus === "not_reviewed")).toBe(true);
    const rejected = listed.data.filter((row) => row.acceptanceStatus === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    expect(
      rejected.some((row) =>
        row.failureClass === "json_invalid"
        || row.failureClass === "schema_invalid"
        || row.failureClass === "meta_validation_chatter"
        || row.failureClass === "unknown",
      ),
    ).toBe(true);
    expect(rejected.every((row) => row.failureProvisional === true)).toBe(true);
    expect(turns.every((turn) => !/not valid JSON|previous generation was rejected/i.test(turn.body))).toBe(true);
    const withRaw = await evidence.getAttempt(admin(), rejected[0]!.id, true);
    expect(withRaw.attempt.rawOutput).toBeTruthy();
    expect(withRaw.provenance.knowledgeSystem).toBe("separate");
    expect(withRaw.attempt.datasetIncluded).toBe(false);
  });

  it("links a retry attempt to the original failure", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = recoveringProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "continual learning",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c16-retry-link-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 3 });
    const listed = await evidence.listAttempts(admin(), { conversationId: opened.conversationId, limit: 50 });
    const recovered = listed.data.find((row) => row.acceptanceStatus === "recovered" || row.recoveryOfAttemptId);
    expect(recovered?.parentAttemptId || recovered?.recoveryOfAttemptId).toBeTruthy();
    if (recovered?.parentAttemptId) {
      const parent = listed.data.find((row) => row.id === recovered.parentAttemptId);
      expect(parent?.acceptanceStatus).toBe("rejected");
    }
  });

  it("keeps verified corrections ineligible for training datasets", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = recoveringProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "continual learning",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c16-correct-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 2 });
    const listed = await evidence.listAttempts(admin(), { conversationId: opened.conversationId, limit: 20 });
    const attempt = listed.data[0]!;
    const correction = await evidence.proposeCorrection(admin(), {
      attemptId: attempt.id,
      proposedResponse: '{"kind":"response","body":"Use elastic weight consolidation with a Fisher diagonal estimate."}',
      supportingEvidence: "Human specialist rewrite",
    });
    expect(correction.verificationStatus).toBe("unverified");
    await expect(
      evidence.reviewCorrection(deptAgent(), correction.id, { decision: "verified", method: "human_peer_review" }),
    ).rejects.toThrow(/permission/i);
    const second = await evidence.proposeCorrection(admin(), {
      attemptId: attempt.id,
      proposedResponse: '{"kind":"response","body":"Do not verify this via another LLM."}',
    });
    await expect(
      evidence.reviewCorrection(admin(), second.id, { decision: "verified", method: "another LLM agrees" }),
    ).rejects.toThrow(/LLM|agrees/i);
    const verified = await evidence.reviewCorrection(admin(), correction.id, {
      decision: "verified",
      method: "human_peer_review",
      evidence: "Checked against Fisher information literature",
    });
    expect(verified.verificationStatus).toBe("verified");
    const eligibility = await evidence.setEligibility(admin(), attempt.id, {
      status: "verified_for_dataset",
      reason: "Reviewed for future dataset candidacy only",
    });
    expect(eligibility.trainingEligible).toBe(false);
    expect(eligibility.eligibilityStatus).toBe("verified_for_dataset");
    expect(eligibility.datasetIncluded).toBe(false);
    const refreshed = await evidence.getAttempt(admin(), attempt.id, false);
    expect(refreshed.attempt.trainingEligible).toBe(false);
    expect(refreshed.corrections.some((row) => row.id === correction.id && row.verificationStatus === "verified")).toBe(true);
    expect(refreshed.corrections.some((row) => row.id === second.id && row.verificationStatus === "unverified")).toBe(true);
  });

  it("does not classify a repeated mathematical objection as verified reasoning_error", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = repetitiveMathProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "continual learning math",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c16-math-repeat-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 4 });
    const listed = await evidence.listAttempts(admin(), { conversationId: opened.conversationId, limit: 50 });
    const repetitive = listed.data.filter((row) => row.failureClass === "repetition");
    expect(repetitive.length).toBeGreaterThan(0);
    expect(repetitive.every((row) => row.failureClass !== "reasoning_error")).toBe(true);
    expect(repetitive.every((row) => row.failureProvisional === true)).toBe(true);
    expect(repetitive.every((row) => row.classificationConfidence === "observed")).toBe(true);
    expect(repetitive.every((row) => row.trainingEligible === false)).toBe(true);
  });

  it("records observable evidence capture failures without claiming success", async () => {
    await seed(testDb());
    await enable();
    const { dialogue } = services();
    const provider = recoveringProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "capture failure",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c16-capture-fail-0001",
    });
    const evidence = new TrainingEvidenceService(persistence, new Authorizer(), undefined, () => new Date(now));
    const broken = {
      ...persistence,
      repos: {
        ...persistence.repos,
        evidence: {
          ...persistence.repos.evidence,
          async insertAttempt() {
            throw new Error("simulated write failure");
          },
        },
      },
    };
    const failing = new TrainingEvidenceService(broken as typeof persistence, new Authorizer(), undefined, () => new Date(now));
    const result = await failing.captureAttempt({
      conversationId: opened.conversationId,
      departmentId: MATH_DEPARTMENT,
      messages: [{ role: "user", content: "hello" }],
      rawOutput: '{"kind":"response","body":"ok"}',
      inferenceEndpoint: "mock-math",
      attemptNumber: 1,
      latencyMs: 12,
      acceptanceStatus: "accepted",
    });
    expect(result).toBeNull();
    const failures = await evidence.listCaptureFailures(admin(), 10);
    expect(failures.data.some((row) => String(row.error).includes("simulated write failure"))).toBe(true);
  });

  it("rejects unauthorized raw evidence reads and unauthorized verification", async () => {
    await seed(testDb());
    await enable();
    const { dialogue, runner, evidence } = services();
    const provider = recoveringProvider();
    const opened = await dialogue.open(agent(), provider, route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "continual learning",
      kind: "question",
      instruction: INSTRUCTION,
      idempotencyKey: "c16-auth-0001",
    });
    await runner.run(admin(), opened.conversationId, provider, route, { maxTurns: 2 });
    const listed = await evidence.listAttempts(admin(), { conversationId: opened.conversationId, limit: 5, includeRaw: true });
    expect(listed.data[0]?.rawOutput).toBeTruthy();
    const redacted = await evidence.listAttempts(deptAgent(), { conversationId: opened.conversationId, limit: 5, includeRaw: true });
    expect(redacted.data[0]?.rawOutput).toBeNull();
    await expect(evidence.listAttempts(observer(), { conversationId: opened.conversationId })).rejects.toThrow(/permission/i);
  });
});

function recoveringProvider(): InferenceProvider {
  let runnerCalls = 0;
  return {
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, "What assumptions separate replay from EWC?");
      }
      runnerCalls += 1;
      if (runnerCalls === 1) {
        return observed(
          request,
          JSON.stringify({
            kind: "response",
            body: "The previous JSON failed validation because it did not include the required fields 'kind' and 'body'. Here is the corrected JSON object with the required fields.",
            decision: "speak",
          }),
        );
      }
      return observed(
        request,
        JSON.stringify({
          kind: "response",
          body: "Fisher information regularization can stabilize continual learning when the diagonal estimate is maintained across tasks.",
          decision: "speak",
        }),
      );
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function repetitiveMathProvider(): InferenceProvider {
  let calls = 0;
  const objection = JSON.stringify({
    kind: "challenge",
    body: "The proposed loss L = E[(f_theta(x) - y)^2] + lambda * sum_i F_i (theta_i - theta*_i)^2 remains unverified for non-diagonal Fisher approximations.",
  });
  return {
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      calls += 1;
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (!system.includes("Return one JSON object")) {
        return observed(request, "Opening continual learning math question");
      }
      const text =
        calls <= 2
          ? JSON.stringify({
              kind: "question",
              body: "Does elastic weight consolidation require a diagonal Fisher information estimate?",
            })
          : objection;
      return observed(request, text);
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return { text, servedModel: request.modelAlias, usage: { inputTokens: 20, outputTokens: 30, source: "observed" }, latencyMs: 8 };
}

function services() {
  const authorizer = new Authorizer();
  const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY, () => new Date(now));
  const dialogue = new DialogueService(persistence, authorizer, messages, () => new Date(now));
  const runner = new ConversationRunner(persistence, authorizer, dialogue, () => new Date(now));
  const evidence = new TrainingEvidenceService(persistence, authorizer, undefined, () => new Date(now));
  return { dialogue, runner, evidence };
}

async function enable(): Promise<void> {
  await persistence.repos.autonomy.saveSettings({
    conversationExecutionEnabled: true,
    maxConversationMessages: 12,
    conversationSoftTokenBudget: 1_500,
    conversationHardTokenCeiling: 8_000,
    conversationCheckpointTurns: 4,
  });
}

function admin(): RequestContext {
  return {
    correlationId: "c16-admin",
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
    correlationId: "c16-science",
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

function deptAgent(): RequestContext {
  return agent();
}

function observer(): RequestContext {
  return {
    correlationId: "c16-observer",
    actor: {
      principalId: "00000000-0000-4000-8000-0000000000ff",
      principalType: "human",
      role: "read_only_observer",
      agentId: null,
      departmentId: null,
      permissions: [],
    },
  };
}
