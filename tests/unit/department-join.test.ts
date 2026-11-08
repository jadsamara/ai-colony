import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Authorizer,
  DepartmentJoinService,
  DialogueService,
  DomainError,
  buildJoinTaskBrief,
  orchestrationJoinSchema,
  type InferenceProvider,
  type InferenceRoute,
  type Persistence,
  type RequestContext,
} from "@ai-colony/core";

const scienceId = "00000000-0000-4000-8000-00000000001b";
const mathId = "00000000-0000-4000-8000-000000000019";
const researchId = "00000000-0000-4000-8000-000000000018";
const orchId = "00000000-0000-4000-8000-000000000012";
const reasoningId = "00000000-0000-4000-8000-00000000001a";
const scienceAgent = "00000000-0000-4000-8000-000000000205";
const conversationId = "00000000-0000-4000-8000-000000000501";

describe("C1.7.2 department join requests", () => {
  it("parses Orchestration join decisions strictly", () => {
    expect(
      orchestrationJoinSchema.parse({ approve: true, rationale: "Need research evidence.", confidence: "high" }),
    ).toMatchObject({
      approve: true,
      confidence: "high",
    });
    expect(() =>
      orchestrationJoinSchema.parse({ approve: true, rationale: "x", confidence: "high", extra: 1 }),
    ).toThrow();
    expect(
      buildJoinTaskBrief({ targetSlug: "research", justification: "Cite sources.", rationale: "Evidence required." }),
    ).toContain("Assigned task: Cite sources.");
  });

  it("adds an additive join-request migration and join_approval purpose", () => {
    const sql = readFileSync("packages/database/src/migrations/0026_department_join_requests.sql", "utf8");
    expect(sql).toContain('CREATE TABLE "department_join_requests"');
    expect(sql).toContain("join_approval");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.toLowerCase()).not.toContain("delete from");
  });

  it("approves a join through Orchestration, seats via dialogue.seatInvitee, and is idempotent", async () => {
    const harness = joinHarness();
    const service = serviceFor(harness);
    const provider = orchestrationJoinProvider({ approve: true, rationale: "Research can cite sources.", confidence: "high" });
    const first = await service.requestJoin(ctx(), provider, route(), conversationId, {
      targetDepartmentId: researchId,
      justification: "Need evidence citations for the claim.",
      idempotencyKey: "join-ok-0001",
    });
    expect(first.status).toBe("approved");
    expect(first.targetSlug).toBe("research");
    expect(first.taskBrief).toContain("Need evidence citations");
    expect(harness.state.seatCalls).toBe(1);
    expect(harness.state.reserveCalls).toBe(1);
    expect(harness.state.reconcileCalls).toBe(1);
    expect(harness.state.audits.some((row) => row.eventType === "conversation.join_request.approved")).toBe(true);

    const replay = await service.requestJoin(ctx(), provider, route(), conversationId, {
      targetDepartmentId: researchId,
      justification: "Need evidence citations for the claim.",
      idempotencyKey: "join-ok-0001",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.requestId).toBe(first.requestId);
    expect(harness.state.seatCalls).toBe(1);
    expect(harness.state.reserveCalls).toBe(1);
  });

  it("records Orchestration rejection without seating the target", async () => {
    const harness = joinHarness();
    const service = serviceFor(harness);
    const result = await service.requestJoin(
      ctx(),
      orchestrationJoinProvider({ approve: false, rationale: "Out of scope.", confidence: "medium" }),
      route(),
      conversationId,
      {
        targetDepartmentId: researchId,
        justification: "Invite research anyway.",
        idempotencyKey: "join-reject-0001",
      },
    );
    expect(result.status).toBe("rejected");
    expect(result.decisionRationale).toBe("Out of scope.");
    expect(harness.state.seatCalls).toBe(0);
    expect(harness.state.audits.some((row) => row.eventType === "conversation.join_request.rejected")).toBe(true);
  });

  it("records model failure as failed and never treats it as approval", async () => {
    const harness = joinHarness();
    const service = serviceFor(harness);
    const provider: InferenceProvider = {
      async generate() {
        return {
          text: "not-json",
          servedModel: "qwen3-8b",
          usage: { inputTokens: 3, outputTokens: 2, source: "observed" },
          latencyMs: 2,
        };
      },
      async probe() {
        return { reachable: true, modelIds: ["qwen3-8b"], error: null };
      },
    };
    const result = await service.requestJoin(ctx(), provider, route(), conversationId, {
      targetDepartmentId: researchId,
      justification: "Need evidence.",
      idempotencyKey: "join-fail-0001",
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBeTruthy();
    expect(harness.state.seatCalls).toBe(0);
    expect(harness.state.audits.some((row) => row.eventType === "conversation.join_request.failed")).toBe(true);
  });

  it("rejects unauthorized non-participants, inactive targets, and duplicate membership", async () => {
    const harness = joinHarness();
    const service = serviceFor(harness);
    const provider = orchestrationJoinProvider({ approve: true, rationale: "yes", confidence: "high" });

    await expect(
      service.requestJoin(outsiderCtx(), provider, route(), conversationId, {
        targetDepartmentId: researchId,
        justification: "Outsider request.",
        idempotencyKey: "join-unauth-0001",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });

    await expect(
      service.requestJoin(ctx(), provider, route(), conversationId, {
        targetDepartmentId: "00000000-0000-4000-8000-000000000099",
        justification: "Missing department.",
        idempotencyKey: "join-missing-0001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });

    harness.state.membership.set(researchId, { membership: "active", role: "specialist" });
    await expect(
      service.requestJoin(ctx(), provider, route(), conversationId, {
        targetDepartmentId: researchId,
        justification: "Already seated.",
        idempotencyKey: "join-dup-0001",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails closed on colony budget exhaustion without seating", async () => {
    const harness = joinHarness({ colonyMaxInferenceRequests: 0 });
    const service = serviceFor(harness);
    let calls = 0;
    const provider: InferenceProvider = {
      async generate() {
        calls += 1;
        throw new Error("must not generate");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    await expect(
      service.requestJoin(ctx(), provider, route(), conversationId, {
        targetDepartmentId: researchId,
        justification: "Budget denied.",
        idempotencyKey: "join-budget-0001",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { budgetDenial: true } });
    expect(calls).toBe(0);
    expect(harness.state.seatCalls).toBe(0);
  });

  it("enforces concurrent join reservations against the colony request budget", async () => {
    const harness = joinHarness({ colonyMaxInferenceRequests: 1 });
    const service = serviceFor(harness);
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
        if (system.includes("Orchestration department")) {
          enteredGenerate?.();
          await blocked;
          return {
            text: JSON.stringify({ approve: true, rationale: "first", confidence: "high" }),
            servedModel: "qwen3-8b",
            usage: { inputTokens: 4, outputTokens: 3, source: "observed" as const },
            latencyMs: 1,
          };
        }
        return {
          text: "turn",
          servedModel: "qwen3-8b",
          usage: { inputTokens: 1, outputTokens: 1, source: "observed" as const },
          latencyMs: 1,
        };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const first = service.requestJoin(ctx(), provider, route(), conversationId, {
      targetDepartmentId: researchId,
      justification: "First concurrent join.",
      idempotencyKey: "join-conc-0001",
    });
    await sawGenerate;
    await expect(
      service.requestJoin(ctx(), provider, route(), conversationId, {
        targetDepartmentId: reasoningId,
        justification: "Second concurrent join.",
        idempotencyKey: "join-conc-0002",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    releaseGate?.();
    const won = await first;
    expect(won.status).toBe("approved");
  });
});

function serviceFor(harness: ReturnType<typeof joinHarness>) {
  const dialogue = {
    async seatInvitee(_ctx: RequestContext, _conversationId: string, departmentId: string, _reason: string) {
      harness.state.seatCalls += 1;
      harness.state.membership.set(departmentId, { membership: "invited", role: "specialist" });
    },
  } as unknown as DialogueService;
  return new DepartmentJoinService(harness.persistence, new Authorizer(), dialogue, () => new Date("2026-06-06T00:00:00.000Z"));
}

function orchestrationJoinProvider(decision: {
  approve: boolean;
  rationale: string;
  confidence: "high" | "medium" | "low";
}): InferenceProvider {
  return {
    async generate(request) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Orchestration department")) {
        return {
          text: JSON.stringify(decision),
          servedModel: "qwen3-8b",
          usage: { inputTokens: 10, outputTokens: 8, source: "observed" },
          latencyMs: 3,
        };
      }
      return {
        text: "prepared fallback",
        servedModel: "qwen3-8b",
        usage: { inputTokens: 1, outputTokens: 1, source: "observed" },
        latencyMs: 1,
      };
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
}

function route(): InferenceRoute {
  return {
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
}

function ctx(): RequestContext {
  return {
    correlationId: "join-science",
    actor: {
      principalId: scienceAgent,
      principalType: "agent",
      role: "department_agent",
      agentId: scienceAgent,
      departmentId: scienceId,
      permissions: [],
    },
  };
}

function outsiderCtx(): RequestContext {
  return {
    correlationId: "join-outsider",
    actor: {
      principalId: "00000000-0000-4000-8000-000000000206",
      principalType: "agent",
      role: "department_agent",
      agentId: "00000000-0000-4000-8000-000000000206",
      departmentId: researchId,
      permissions: [],
    },
  };
}

function joinHarness(seed: { colonyMaxInferenceRequests?: number; colonyConsumed?: number; colonyReserved?: number } = {}) {
  const state = {
    seatCalls: 0,
    reserveCalls: 0,
    releaseCalls: 0,
    reconcileCalls: 0,
    colonyConsumed: seed.colonyConsumed ?? 0,
    colonyReserved: seed.colonyReserved ?? 0,
    colonyMaxInferenceRequests: seed.colonyMaxInferenceRequests ?? 4,
    membership: new Map<string, { membership: string; role: string }>([
      [scienceId, { membership: "active", role: "opener" }],
      [mathId, { membership: "active", role: "participant" }],
    ]),
    joinRequests: new Map<string, Record<string, unknown>>(),
    joinsById: new Map<string, Record<string, unknown>>(),
    inferences: new Map<string, { id: string; status: string; reservedOutputTokens: number; leaseUntil: string | null }>(),
    audits: [] as Array<{ eventType: string }>,
  };

  const departments = {
    async list() {
      return {
        data: [
          { id: scienceId, slug: "science", name: "Science", status: "active" },
          { id: mathId, slug: "math", name: "Math", status: "active" },
          { id: researchId, slug: "research", name: "Research", status: "active" },
          { id: orchId, slug: "orchestration", name: "Orchestration", status: "active" },
          { id: reasoningId, slug: "reasoning", name: "Reasoning", status: "active" },
        ],
        nextCursor: null,
      };
    },
  };

  const autonomy = {
    async settings() {
      return {
        enabled: false,
        paused: false,
        intervalMs: 1,
        cooldownMs: 1,
        maxActiveGoals: 1,
        maxInferenceRequests: state.colonyMaxInferenceRequests,
        maxDurationMs: 1,
        maxConversations: 4,
        maxConversationMessages: 12,
        maxConversationTokens: 4000,
        maxConversationParticipants: 12,
        conversationExecutionEnabled: false,
        maxConcurrentConversationTurns: 1,
        contextTokenBudget: 1500,
        conversationSoftTokenBudget: 20_000,
        conversationHardTokenCeiling: 60_000,
        conversationCheckpointTurns: 10,
        maxInferenceOutputTokens: 4_000,
        maxInferenceEstimatedTokens: 32_000,
        consumedInferenceRequests: state.colonyConsumed,
        reservedInferenceRequests: state.colonyReserved,
        consumedInputTokens: 0,
        consumedOutputTokens: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        reservedOutputTokens: 0,
        estimatedCostUsdMicros: null,
        lastCycleAt: null,
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
    },
    async findConversation(id: string) {
      if (id !== conversationId) return null;
      return {
        id: conversationId,
        topic: "Are the assumptions adequate?",
        objectiveId: null,
        status: "open",
        openerDepartmentId: scienceId,
        openingInstruction: "Discuss assumptions.",
        runnerStatus: "idle",
        runnerLeaseUntil: null,
        contextSummary: null,
        createdAt: "2026-06-06T00:00:00.000Z",
      };
    },
    async listParticipants(id: string) {
      if (id !== conversationId) return [];
      return [...state.membership.entries()]
        .filter(([, row]) => row.membership === "active")
        .map(([departmentId]) => departmentId);
    },
    async listMembership(id: string) {
      if (id !== conversationId) return [];
      return [...state.membership.entries()].map(([departmentId, row]) => ({
        conversationId,
        departmentId,
        membership: row.membership,
        role: row.role,
        invitedByDepartmentId: scienceId,
        joinedAt: row.membership === "active" ? "2026-06-06T00:00:00.000Z" : null,
        removedAt: null,
        joinSequence: 1,
      }));
    },
    async department(id: string) {
      const found = (await departments.list()).data.find((row) => row.id === id);
      return found ?? null;
    },
    async departmentAgent(id: string) {
      const found = await autonomy.department(id);
      return found ? { id: `${id}-agent`, status: "idle", departmentId: id } : null;
    },
  };

  const objectives = {
    async getRun() {
      return null;
    },
    async reserve() {
      state.reserveCalls += 1;
      if (state.colonyConsumed + state.colonyReserved + 1 > state.colonyMaxInferenceRequests) {
        return false;
      }
      state.colonyReserved += 1;
      return true;
    },
    async releaseReservation() {
      state.releaseCalls += 1;
      state.colonyReserved = Math.max(0, state.colonyReserved - 1);
    },
    async reconcile() {
      state.reconcileCalls += 1;
      state.colonyReserved = Math.max(0, state.colonyReserved - 1);
      state.colonyConsumed += 1;
    },
    async insertInference(input: { id: string; idempotencyKey: string; reservedOutputTokens: number }) {
      if (state.inferences.has(input.idempotencyKey)) {
        return "exists";
      }
      state.inferences.set(input.idempotencyKey, {
        id: input.id,
        status: "running",
        reservedOutputTokens: input.reservedOutputTokens,
        leaseUntil: "2026-06-06T00:01:00.000Z",
      });
      return "created";
    },
    async getInference(key: string) {
      const row = state.inferences.get(key);
      return row
        ? {
            id: row.id,
            status: row.status,
            reservedOutputTokens: row.reservedOutputTokens,
            responseText: null,
            purpose: "join_approval",
            leaseUntil: row.leaseUntil,
            departmentId: orchId,
            objectiveId: null,
          }
        : null;
    },
    async reopenInference() {
      return undefined;
    },
    async finishInference(id: string, patch: { status: string }) {
      for (const [key, row] of state.inferences) {
        if (row.id === id) {
          state.inferences.set(key, { ...row, status: patch.status });
        }
      }
    },
    async insertUsage() {
      return undefined;
    },
  };

  const departmentJoinRequests = {
    async insert(row: Record<string, unknown>) {
      if (state.joinRequests.has(String(row.idempotencyKey))) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "This department join request idempotency key was already used", 409);
      }
      state.joinRequests.set(String(row.idempotencyKey), row);
      state.joinsById.set(String(row.id), row);
      return row;
    },
    async findByIdempotencyKey(key: string) {
      return state.joinRequests.get(key) ?? null;
    },
    async findById(id: string) {
      return state.joinsById.get(id) ?? null;
    },
    async listByConversation() {
      return [...state.joinRequests.values()];
    },
  };

  const audit = {
    async append(input: { eventType: string }) {
      state.audits.push(input);
    },
  };

  const repos = {
    departments,
    autonomy,
    objectives,
    departmentJoinRequests,
    audit,
  };

  const persistence = {
    repos,
    async transaction<T>(work: (repos: typeof repos) => Promise<T>) {
      return work(repos);
    },
    async ping() {},
    async close() {},
  } as unknown as Persistence;

  return { persistence, state };
}
