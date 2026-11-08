import { describe, expect, it } from "vitest";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  DepartmentJoinService,
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

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const RESEARCH_DEPARTMENT = "00000000-0000-4000-8000-000000000018";
const RESEARCH = "00000000-0000-4000-8000-000000000206";
const REASONING_DEPARTMENT = "00000000-0000-4000-8000-00000000001a";
const ORCHESTRATION_DEPARTMENT = "00000000-0000-4000-8000-000000000012";

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
let now = Date.parse("2026-06-06T00:00:00.000Z");

describe("C1.7.2 dynamic department joining integration", () => {
  it("approves a join request, seats the specialist as invited with a task brief, and replays idempotently", async () => {
    await seed(testDb());
    const { dialogue, joins } = services();
    const opened = await dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), turnProvider(), route, {
      recipientDepartmentId: MATH_DEPARTMENT,
      topic: "Are the current mathematical assumptions adequate?",
      kind: "question",
      instruction: "Ask Math whether the assumptions hold.",
      idempotencyKey: "c172-open-0001",
    });
    const provider = orchestrationJoinProvider({
      approve: true,
      rationale: "Research can supply citation checks.",
      confidence: "high",
    });
    const approved = await joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
      targetDepartmentId: RESEARCH_DEPARTMENT,
      justification: "Need citation evidence for the zero-case claim.",
      idempotencyKey: "c172-join-ok-0001",
    });
    expect(approved.status).toBe("approved");
    expect(approved.targetSlug).toBe("research");
    expect(approved.taskBrief).toContain("Need citation evidence");
    expect(approved.modelMetadata?.purpose).toBe("join_approval");
    expect(approved.modelMetadata?.departmentId).toBe(ORCHESTRATION_DEPARTMENT);

    const membership = await persistence.repos.autonomy.listMembership(opened.conversationId);
    expect(membership.some((row) => row.departmentId === RESEARCH_DEPARTMENT && row.membership === "invited")).toBe(true);

    const inference = await persistence.repos.objectives.getInference("join:c172-join-ok-0001");
    expect(inference?.purpose).toBe("join_approval");
    expect(inference?.status).toBe("completed");
    expect(inference?.departmentId).toBe(ORCHESTRATION_DEPARTMENT);

    const replay = await joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
      targetDepartmentId: RESEARCH_DEPARTMENT,
      justification: "Need citation evidence for the zero-case claim.",
      idempotencyKey: "c172-join-ok-0001",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.requestId).toBe(approved.requestId);

    await dialogue.accept(agent(RESEARCH, RESEARCH_DEPARTMENT), opened.conversationId);
    const afterAccept = await persistence.repos.autonomy.listMembership(opened.conversationId);
    expect(afterAccept.some((row) => row.departmentId === RESEARCH_DEPARTMENT && row.membership === "active")).toBe(true);
  });

  it("records Orchestration rejection and model failure without seating", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 4 });
    const { dialogue, joins } = services();
    const opened = await openConversation(dialogue);
    const rejected = await joins.requestJoin(
      agent(SCIENCE, SCIENCE_DEPARTMENT),
      orchestrationJoinProvider({ approve: false, rationale: "Unnecessary for this arithmetic dispute.", confidence: "high" }),
      route,
      opened.conversationId,
      {
        targetDepartmentId: RESEARCH_DEPARTMENT,
        justification: "Invite research without need.",
        idempotencyKey: "c172-join-reject-0001",
      },
    );
    expect(rejected.status).toBe("rejected");
    expect(await membershipOf(opened.conversationId, RESEARCH_DEPARTMENT)).toBeNull();

    const failed = await joins.requestJoin(
      agent(SCIENCE, SCIENCE_DEPARTMENT),
      malformedProvider(),
      route,
      opened.conversationId,
      {
        targetDepartmentId: RESEARCH_DEPARTMENT,
        justification: "Need research despite model failure.",
        idempotencyKey: "c172-join-fail-0001",
      },
    );
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBeTruthy();
    expect(await membershipOf(opened.conversationId, RESEARCH_DEPARTMENT)).toBeNull();
  });

  it("rejects unauthorized requesters, inactive targets, and duplicate membership", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 4 });
    const { dialogue, joins } = services();
    const opened = await openConversation(dialogue);
    const provider = orchestrationJoinProvider({ approve: true, rationale: "yes", confidence: "high" });

    await expect(
      joins.requestJoin(agent(RESEARCH, RESEARCH_DEPARTMENT), provider, route, opened.conversationId, {
        targetDepartmentId: REASONING_DEPARTMENT,
        justification: "Outsider cannot request.",
        idempotencyKey: "c172-join-unauth-0001",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });

    await expect(
      joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        targetDepartmentId: "00000000-0000-4000-8000-0000000000ff",
        justification: "Unknown department.",
        idempotencyKey: "c172-join-missing-0001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });

    await joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
      targetDepartmentId: RESEARCH_DEPARTMENT,
      justification: "Seat research once.",
      idempotencyKey: "c172-join-once-0001",
    });
    await expect(
      joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        targetDepartmentId: RESEARCH_DEPARTMENT,
        justification: "Seat research again.",
        idempotencyKey: "c172-join-dup-0001",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not convert ad-hoc budget denial into an approved join", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 0 });
    const { dialogue, joins } = services();
    const opened = await openConversation(dialogue);
    let generateCalls = 0;
    const provider: InferenceProvider = {
      async generate(request) {
        generateCalls += 1;
        return observed(request, "should not run");
      },
      async probe() {
        return { reachable: true, modelIds: ["qwen3-8b"], error: null };
      },
    };
    await expect(
      joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        targetDepartmentId: RESEARCH_DEPARTMENT,
        justification: "Budget should deny this.",
        idempotencyKey: "c172-join-budget-0001",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { budgetDenial: true } });
    expect(generateCalls).toBe(0);
    expect(await persistence.repos.departmentJoinRequests.findByIdempotencyKey("c172-join-budget-0001")).toBeNull();
  });

  it("enforces concurrent join reservations against the colony request budget", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 1 });
    const { dialogue, joins } = services();
    const opened = await openConversation(dialogue);
    let releaseGate: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let enteredGenerate: (() => void) | null = null;
    const sawGenerate = new Promise<void>((resolve) => {
      enteredGenerate = resolve;
    });
    const provider: InferenceProvider = {
      async generate(request) {
        const system = request.messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("Orchestration department") && system.includes("join")) {
          enteredGenerate?.();
          await blocked;
          return observed(
            request,
            JSON.stringify({ approve: true, rationale: "first concurrent winner", confidence: "high" }),
          );
        }
        return observed(request, "Opening turn text for dialogue.");
      },
      async probe() {
        return { reachable: true, modelIds: ["qwen3-8b"], error: null };
      },
    };
    const first = joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
      targetDepartmentId: RESEARCH_DEPARTMENT,
      justification: "First concurrent join.",
      idempotencyKey: "c172-join-conc-0001",
    });
    await sawGenerate;
    await expect(
      joins.requestJoin(agent(SCIENCE, SCIENCE_DEPARTMENT), provider, route, opened.conversationId, {
        targetDepartmentId: REASONING_DEPARTMENT,
        justification: "Second concurrent join.",
        idempotencyKey: "c172-join-conc-0002",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    releaseGate?.();
    const won = await first;
    expect(won.status).toBe("approved");
    const settings = await persistence.repos.autonomy.settings();
    expect(settings.consumedInferenceRequests).toBe(1);
    expect(settings.reservedInferenceRequests).toBe(0);
  });
});

function services() {
  const authorizer = new Authorizer();
  const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY, () => new Date(now));
  const dialogue = new DialogueService(persistence, authorizer, messages, () => new Date(now));
  const joins = new DepartmentJoinService(persistence, authorizer, dialogue, () => new Date(now));
  return { dialogue, joins };
}

async function openConversation(dialogue: DialogueService) {
  return dialogue.open(agent(SCIENCE, SCIENCE_DEPARTMENT), turnProvider(), route, {
    recipientDepartmentId: MATH_DEPARTMENT,
    topic: "Are the current mathematical assumptions adequate?",
    kind: "question",
    instruction: "Ask Math whether the assumptions hold.",
    idempotencyKey: `c172-open-${Math.random().toString(16).slice(2, 10)}`,
  });
}

async function membershipOf(conversationId: string, departmentId: string) {
  const rows = await persistence.repos.autonomy.listMembership(conversationId);
  return rows.find((row) => row.departmentId === departmentId) ?? null;
}

function turnProvider(): InferenceProvider {
  return {
    async generate(request) {
      return observed(request, "Opening turn text for dialogue.");
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function orchestrationJoinProvider(decision: {
  approve: boolean;
  rationale: string;
  confidence: "high" | "medium" | "low";
}): InferenceProvider {
  return {
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Orchestration department") && system.includes("join")) {
        return observed(request, JSON.stringify(decision));
      }
      return observed(request, "Opening turn text for dialogue.");
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function malformedProvider(): InferenceProvider {
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Orchestration department") && system.includes("join")) {
        return observed(request, "not-json at all");
      }
      return observed(request, "Opening turn text for dialogue.");
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return {
    text,
    servedModel: request.modelAlias,
    usage: { inputTokens: 10, outputTokens: 12, source: "observed" },
    latencyMs: 4,
  };
}

function agent(agentId: string, departmentId: string): RequestContext {
  return {
    correlationId: `c172-${departmentId.slice(-4)}`,
    actor: {
      principalId: agentId,
      principalType: "agent",
      role: "department_agent",
      agentId,
      departmentId,
      permissions: [],
    },
  };
}
