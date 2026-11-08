import { describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  DialogueService,
  MessagingService,
  ObjectiveService,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { testDb } from "../helpers/db.js";

const SCIENCE = "00000000-0000-4000-8000-000000000205";
const PRODUCT = "00000000-0000-4000-8000-000000000213";
const SCIENCE_DEPARTMENT = "00000000-0000-4000-8000-00000000001b";
const MATH_DEPARTMENT = "00000000-0000-4000-8000-000000000019";
const RESEARCH_DEPARTMENT = "00000000-0000-4000-8000-000000000018";
const REASONING_DEPARTMENT = "00000000-0000-4000-8000-00000000001a";
const EVALUATION_DEPARTMENT = "00000000-0000-4000-8000-000000000017";
const MEMORY_DEPARTMENT = "00000000-0000-4000-8000-000000000016";
const WEIGHT_DEPARTMENT = "00000000-0000-4000-8000-000000000015";
const ORCHESTRATION_DEPARTMENT = "00000000-0000-4000-8000-000000000012";
const CEO_DEPARTMENT = "00000000-0000-4000-8000-000000000011";
const MONITORING_DEPARTMENT = "00000000-0000-4000-8000-000000000013";
const EVOLUTION_DEPARTMENT = "00000000-0000-4000-8000-000000000014";
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

const persistence = createPersistence(testDb(), async () => undefined);
let now = Date.parse("2026-06-06T00:00:00.000Z");

describe("C1.7.1 hybrid department routing integration", () => {
  it("routes simple arithmetic to Math without Orchestration inference", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const provider = trackingProvider();
    const routing = await dialogue.routeDepartments(agent(), provider.provider, route, {
      task: "What's 2 + 2?",
      idempotencyKey: "c171-arith-0001",
    });
    expect(routing.method).toBe("deterministic");
    expect(routing.primaryDepartmentId).toBe(MATH_DEPARTMENT);
    expect(routing.additionalDepartmentIds).toEqual([]);
    expect(provider.orchestrationCalls).toBe(0);
    const again = await dialogue.routeDepartments(agent(), provider.provider, route, {
      task: "What's 2 + 2?",
      idempotencyKey: "c171-arith-0001",
    });
    expect(again.decisionId).toBe(routing.decisionId);
    expect(again.idempotentReplay).toBe(true);
    expect(provider.orchestrationCalls).toBe(0);
  });

  it("selects Science and Math through a mocked Orchestration model for complex physics", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math", "science", "gaming", "engineering"],
      rationale: "Gravitational waves require physics interpretation and mathematical formalism.",
      confidence: "high",
      approvalRequired: false,
    });
    // Opener must not be Science — routed participants cannot include the opener department.
    const routing = await dialogue.routeDepartments(productAgent(), provider, route, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-physics-0001",
    });
    expect(routing.method).toBe("model_assisted");
    expect(routing.primaryDepartmentId).toBe(SCIENCE_DEPARTMENT);
    expect(routing.additionalDepartmentIds).toContain(MATH_DEPARTMENT);
    expect(routing.additionalDepartmentIds).not.toContain(SCIENCE_DEPARTMENT);
    expect(routing.rejectedRecommendations.some((row) => row.slug === "gaming" || row.slug === "engineering")).toBe(true);
    expect(routing.modelMetadata?.departmentSlug).toBe("orchestration");
  });

  it("keeps all active departments eligible and rejects inactive ones", async () => {
    await seed(testDb());
    const { dialogue } = services();
    // Schema caps additionalSlugs at 10; keep gaming so inactive rejection is still asserted.
    const provider = orchestrationProvider({
      primarySlug: "research",
      additionalSlugs: [
        "reasoning",
        "science",
        "math",
        "evaluation",
        "memory-and-forgetting",
        "weight-optimization",
        "ceo",
        "orchestration",
        "monitoring",
        "gaming",
      ],
      rationale: "Autonomous research system spans multiple active departments.",
      confidence: "medium",
      approvalRequired: false,
    });
    const routing = await dialogue.routeDepartments(productAgent(), provider, route, {
      task: "Design an autonomous research system.",
      idempotencyKey: "c171-all-0001",
      maxParticipants: 12,
    });
    expect(routing.method).toBe("model_assisted");
    const allowed = new Set([
      RESEARCH_DEPARTMENT,
      REASONING_DEPARTMENT,
      SCIENCE_DEPARTMENT,
      MATH_DEPARTMENT,
      EVALUATION_DEPARTMENT,
      MEMORY_DEPARTMENT,
      WEIGHT_DEPARTMENT,
      PRODUCT_DEPARTMENT,
      CEO_DEPARTMENT,
      ORCHESTRATION_DEPARTMENT,
      MONITORING_DEPARTMENT,
      EVOLUTION_DEPARTMENT,
    ]);
    expect(routing.finalParticipantIds.every((id) => allowed.has(id))).toBe(true);
    expect(routing.rejectedRecommendations.some((row) => row.slug === "gaming")).toBe(true);
  });

  it("fails safely on malformed Orchestration output and records an explicit fallback", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const provider = malformedProvider();
    const routing = await dialogue.routeDepartments(admin(), provider, route, {
      task: "Improve Math's performance on algebra.",
      idempotencyKey: "c171-malformed-0001",
    });
    expect(routing.method).toBe("fallback");
    expect(routing.fallbackReason).toBeTruthy();
    expect(routing.approvalRequired).toBe(true);
    expect(routing.confidence).toBe("low");
    expect(routing.rationale).toMatch(/not a model decision/i);
  });

  it("opens a hybrid conversation with opener plus primary specialist and keeps manual open intact", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const provider = trackingProvider();
    const hybrid = await dialogue.openHybrid(agent(), provider.provider, route, {
      task: "What's 2 + 2?",
      kind: "question",
      instruction: "Answer the arithmetic question.",
      idempotencyKey: "c171-open-hybrid-0001",
    });
    expect(hybrid.routing.method).toBe("deterministic");
    expect(hybrid.routing.primaryDepartmentId).toBe(MATH_DEPARTMENT);
    expect(hybrid.turn.departmentId).toBe(SCIENCE_DEPARTMENT);
    const members = await persistence.repos.autonomy.listMembership(hybrid.turn.conversationId);
    const active = members.filter((row) => row.membership === "active").map((row) => row.departmentId);
    expect(active).toContain(SCIENCE_DEPARTMENT);
    expect(active).toContain(MATH_DEPARTMENT);
    expect(active).toHaveLength(2);

    const manual = await dialogue.open(agent(), provider.provider, route, {
      recipientDepartmentId: RESEARCH_DEPARTMENT,
      topic: "manual open remains available",
      kind: "question",
      instruction: "Manual recipient path.",
      idempotencyKey: "c171-open-manual-0001",
    });
    expect(manual.conversationId).toBeTruthy();
  });

  it("does not silently fall back to shared inference when dedicated Orchestration routing is required", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "should not be reached",
      confidence: "high",
      approvalRequired: false,
    });
    const dedicated: InferenceRoute = {
      ...route,
      dedicatedRouting: {
        enabled: true,
        instances: [],
        providerFor: () => null,
      },
    };
    const routing = await dialogue.routeDepartments(admin(), provider, dedicated, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-dedicated-0001",
    });
    expect(routing.method).toBe("fallback");
    expect(routing.fallbackReason).toMatch(/dedicated|unavailable|No dedicated/i);
  });

  it("charges colony ad-hoc budget for model-assisted routing without an objective", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const before = await persistence.repos.autonomy.settings();
    expect(before.consumedInferenceRequests).toBe(0);
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "Ad-hoc routing should consume colony inference budget.",
      confidence: "high",
      approvalRequired: false,
    });
    const routing = await dialogue.routeDepartments(agent(), provider, route, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-adhoc-budget-0001",
    });
    expect(routing.method).toBe("model_assisted");
    expect(routing.modelMetadata?.budgetCharged).toBe(true);
    expect(routing.modelMetadata?.budgetScope).toBe("colony");
    expect(routing.modelMetadata?.departmentId).toBe(ORCHESTRATION_DEPARTMENT);
    const after = await persistence.repos.autonomy.settings();
    expect(after.consumedInferenceRequests).toBe(1);
    expect(after.reservedInferenceRequests).toBe(0);
    const inference = await persistence.repos.objectives.getInference("routing:c171-adhoc-budget-0001");
    expect(inference?.objectiveId).toBeNull();
    expect(inference?.departmentId).toBe(ORCHESTRATION_DEPARTMENT);
    expect(inference?.purpose).toBe("routing");
    expect(inference?.status).toBe("completed");
  });

  it("does not convert ad-hoc budget denial into fallback seating", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 0 });
    const { dialogue } = services();
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
      dialogue.routeDepartments(agent(), provider, route, {
        task: "Explain the mathematics behind gravitational waves.",
        idempotencyKey: "c171-adhoc-deny-0001",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { budgetDenial: true } });
    expect(generateCalls).toBe(0);
    expect(await persistence.repos.departmentRouting.findByIdempotencyKey("c171-adhoc-deny-0001")).toBeNull();
  });

  it("enforces concurrent ad-hoc reservations against the colony request budget", async () => {
    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 1 });
    const { dialogue } = services();
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
          return observed(
            request,
            JSON.stringify({
              primarySlug: "science",
              additionalSlugs: ["math"],
              rationale: "first concurrent winner",
              confidence: "high",
              approvalRequired: false,
            }),
          );
        }
        return observed(request, "Opening turn text for dialogue.");
      },
      async probe() {
        return { reachable: true, modelIds: ["qwen3-8b"], error: null };
      },
    };
    const first = dialogue.routeDepartments(agent(), provider, route, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-adhoc-conc-0001",
    });
    await sawGenerate;
    await expect(
      dialogue.routeDepartments(agent(), provider, route, {
        task: "Design an autonomous research system.",
        idempotencyKey: "c171-adhoc-conc-0002",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    releaseGate?.();
    const won = await first;
    expect(won.method).toBe("model_assisted");
    const settings = await persistence.repos.autonomy.settings();
    expect(settings.consumedInferenceRequests).toBe(1);
    expect(settings.reservedInferenceRequests).toBe(0);
  });

  it("does not double-charge ad-hoc idempotent retries", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "Idempotent ad-hoc charge.",
      confidence: "high",
      approvalRequired: false,
    });
    const first = await dialogue.routeDepartments(agent(), provider, route, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-adhoc-idem-0001",
    });
    const second = await dialogue.routeDepartments(agent(), provider, route, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-adhoc-idem-0001",
    });
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.idempotentReplay).toBe(true);
    const settings = await persistence.repos.autonomy.settings();
    expect(settings.consumedInferenceRequests).toBe(1);
  });

  it("records known usage for malformed ad-hoc output and recovers a stale reservation", async () => {
    await seed(testDb());
    const { dialogue } = services();
    const malformed = await dialogue.routeDepartments(admin(), malformedProvider(), route, {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "c171-adhoc-malformed-0001",
    });
    expect(malformed.method).toBe("fallback");
    const afterMalformed = await persistence.repos.autonomy.settings();
    expect(afterMalformed.consumedInferenceRequests).toBe(1);
    expect(afterMalformed.reservedInferenceRequests).toBe(0);

    await seed(testDb());
    await persistence.repos.autonomy.saveSettings({ maxInferenceRequests: 2 });
    const reserved = await persistence.repos.objectives.reserve({
      objectiveId: null,
      outputTokens: 400,
      estimatedTokens: 800,
    });
    expect(reserved).toBe(true);
    const staleId = "00000000-0000-4000-8000-000000000911";
    const created = await persistence.repos.objectives.insertInference({
      id: staleId,
      objectiveId: null,
      departmentId: ORCHESTRATION_DEPARTMENT,
      taskId: null,
      attempt: 1,
      purpose: "routing",
      registryModelId: "00000000-0000-4000-8000-000000000101",
      intendedModelId: "00000000-0000-4000-8000-000000000101",
      requestedAlias: "qwen3-8b",
      reservedOutputTokens: 400,
      idempotencyKey: "routing:c171-adhoc-stale-0001",
      leaseOwner: "department-routing",
      leaseUntil: new Date("2026-06-05T00:00:00.000Z"),
    });
    expect(created).toBe("created");
    const recovered = await dialogue.routeDepartments(
      agent(),
      orchestrationProvider({
        primarySlug: "science",
        additionalSlugs: ["math"],
        rationale: "stale lease recovered",
        confidence: "high",
        approvalRequired: false,
      }),
      route,
      {
        task: "Explain the mathematics behind gravitational waves.",
        idempotencyKey: "c171-adhoc-stale-0001",
      },
    );
    expect(recovered.method).toBe("model_assisted");
    const afterRecover = await persistence.repos.autonomy.settings();
    // Malformed half already consumed one slot; reclaim settles the held reservation into a second consume.
    expect(afterRecover.consumedInferenceRequests).toBe(2);
    expect(afterRecover.reservedInferenceRequests).toBe(0);
    const inference = await persistence.repos.objectives.getInference("routing:c171-adhoc-stale-0001");
    expect(inference?.id).toBe(staleId);
    expect(inference?.status).toBe("completed");
  });

  it("keeps objective-linked routing on the objective budget without consuming colony counters", async () => {
    await seed(testDb());
    const messages = new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY, () => new Date(now));
    const objectives = new ObjectiveService(persistence, new Authorizer(), messages, () => new Date(now));
    const created = await objectives.submit(admin(), {
      objective: "Compare solar and wind for a remote station.",
      limits: { maxInferenceRequests: 4 },
    });
    const before = await persistence.repos.autonomy.settings();
    const { dialogue } = services();
    const routing = await dialogue.routeDepartments(
      agent(),
      orchestrationProvider({
        primarySlug: "science",
        additionalSlugs: ["math"],
        rationale: "Objective-linked routing.",
        confidence: "high",
        approvalRequired: false,
      }),
      route,
      {
        task: "Explain the mathematics behind gravitational waves.",
        objectiveId: created.id,
        idempotencyKey: "c171-objective-budget-0001",
      },
    );
    expect(routing.method).toBe("model_assisted");
    expect(routing.modelMetadata?.budgetScope).toBe("objective");
    const after = await persistence.repos.autonomy.settings();
    expect(after.consumedInferenceRequests).toBe(before.consumedInferenceRequests);
    const run = await persistence.repos.objectives.getRun(created.id);
    expect(run?.consumedRequests).toBe(1);
    const inference = await persistence.repos.objectives.getInference("routing:c171-objective-budget-0001");
    expect(inference?.objectiveId).toBe(created.id);
    expect(inference?.departmentId).toBe(ORCHESTRATION_DEPARTMENT);
  });
});

function services() {
  const authorizer = new Authorizer();
  const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY, () => new Date(now));
  const dialogue = new DialogueService(persistence, authorizer, messages, () => new Date(now));
  return { dialogue };
}

function trackingProvider() {
  let orchestrationCalls = 0;
  const provider: InferenceProvider = {
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Orchestration department")) {
        orchestrationCalls += 1;
      }
      return observed(request, "Opening turn text for dialogue.");
    },
    async probe() {
      return { reachable: true, modelIds: ["qwen3-8b"], error: null };
    },
  };
  return {
    provider,
    get orchestrationCalls() {
      return orchestrationCalls;
    },
  };
}

function orchestrationProvider(decision: {
  primarySlug: string;
  additionalSlugs: string[];
  rationale: string;
  confidence: "high" | "medium" | "low";
  approvalRequired: boolean;
}): InferenceProvider {
  return {
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Orchestration department")) {
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
    async generate(request: InferenceRequest): Promise<InferenceResult> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("Orchestration department")) {
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
  return { text, servedModel: request.modelAlias, usage: { inputTokens: 10, outputTokens: 12, source: "observed" }, latencyMs: 4 };
}

function admin(): RequestContext {
  return {
    correlationId: "c171-admin",
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
    correlationId: "c171-science",
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

function productAgent(): RequestContext {
  return {
    correlationId: "c171-product",
    actor: {
      principalId: PRODUCT,
      principalType: "agent",
      role: "department_agent",
      agentId: PRODUCT,
      departmentId: PRODUCT_DEPARTMENT,
      permissions: [],
    },
  };
}
