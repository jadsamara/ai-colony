import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Authorizer,
  DepartmentRoutingService,
  DomainError,
  tryDeterministicDepartmentRoute,
  validateRoutedDepartments,
  boundedFallbackDepartments,
  routingIdempotencyKey,
  orchestrationRouteSchema,
  selectConversationInference,
  type InferenceProvider,
  type InferenceRoute,
  type Persistence,
  type RequestContext,
} from "@ai-colony/core";
import { assertAdditiveMigration } from "@ai-colony/database";

describe("C1.7.1 hybrid department routing", () => {
  it("routes pure arithmetic to Math without model assistance", () => {
    expect(tryDeterministicDepartmentRoute("What's 2 + 2?")).toMatchObject({
      primarySlug: "math",
      additionalSlugs: [],
      confidence: "high",
    });
    expect(tryDeterministicDepartmentRoute("calculate 12 * 7")).toMatchObject({ primarySlug: "math" });
    expect(tryDeterministicDepartmentRoute("Explain the mathematics behind gravitational waves.")).toBeNull();
    expect(tryDeterministicDepartmentRoute("Design an autonomous research system.")).toBeNull();
    expect(tryDeterministicDepartmentRoute("Improve Math's performance on algebra.")).toBeNull();
  });

  it("rejects unknown, inactive, and duplicate departments and enforces participant budgets", () => {
    const available = [
      { id: "math-id", slug: "math", name: "Math", status: "active" },
      { id: "science-id", slug: "science", name: "Science", status: "active" },
      { id: "research-id", slug: "research", name: "Research", status: "active" },
      { id: "gaming-id", slug: "gaming", name: "Gaming", status: "archived" },
    ];
    const validated = validateRoutedDepartments({
      primarySlug: "science",
      additionalSlugs: ["math", "math", "gaming", "engineering", "research"],
      available,
      maxParticipants: 3,
      excludeDepartmentId: null,
    });
    expect(validated.primary.slug).toBe("science");
    expect(validated.additional.map((row) => row.slug)).toEqual(["math"]);
    expect(validated.rejected.map((row) => row.slug)).toEqual(["math", "gaming", "engineering", "research"]);
    expect(validated.finalIds).toEqual(["science-id", "math-id"]);
  });

  it("keeps all twelve active departments selectable even when participant seating is capped at two", () => {
    const activeSlugs = [
      "ceo",
      "orchestration",
      "monitoring",
      "evolution",
      "weight-optimization",
      "memory-and-forgetting",
      "evaluation",
      "research",
      "math",
      "reasoning",
      "science",
      "product",
    ] as const;
    const available = [
      ...activeSlugs.map((slug, index) => ({
        id: `active-${index}`,
        slug,
        name: slug,
        status: "active",
      })),
      { id: "gaming-id", slug: "gaming", name: "Gaming", status: "archived" },
    ];
    // Eligibility is the active set; maxParticipants only caps final seating (opener + primary).
    const validated = validateRoutedDepartments({
      primarySlug: "science",
      additionalSlugs: [...activeSlugs.filter((slug) => slug !== "science"), "gaming"],
      available,
      maxParticipants: 2,
      excludeDepartmentId: null,
    });
    expect(validated.primary.slug).toBe("science");
    expect(validated.additional).toEqual([]);
    expect(validated.rejected.some((row) => row.slug === "gaming" && row.reason.includes("archived"))).toBe(true);
    expect(
      validated.rejected.filter((row) => row.reason === "exceeded participant budget").map((row) => row.slug),
    ).toEqual(activeSlugs.filter((slug) => slug !== "science"));
    // Every active slug was considered (primary seated or rejected only for budget), none dropped as ineligible.
    const considered = new Set([validated.primary.slug, ...validated.rejected.map((row) => row.slug)]);
    for (const slug of activeSlugs) {
      expect(considered.has(slug)).toBe(true);
    }
  });

  it("promotes an alternate when the opener is the recommended primary", () => {
    const available = [
      { id: "math-id", slug: "math", name: "Math", status: "active" },
      { id: "orch-id", slug: "orchestration", name: "Orchestration", status: "active" },
      { id: "science-id", slug: "science", name: "Science", status: "active" },
    ];
    const alone = validateRoutedDepartments({
      primarySlug: "math",
      additionalSlugs: [],
      available,
      maxParticipants: 4,
      excludeDepartmentId: "math-id",
    });
    expect(alone.primary.slug).toBe("orchestration");
    expect(alone.additional).toEqual([]);
    const promoted = validateRoutedDepartments({
      primarySlug: "science",
      additionalSlugs: ["math"],
      available,
      maxParticipants: 4,
      excludeDepartmentId: "science-id",
    });
    expect(promoted.primary.slug).toBe("math");
  });

  it("keeps routing idempotency keys inside the 8–128 contract", () => {
    const long = "k".repeat(128);
    const key = routingIdempotencyKey(undefined, long);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key.startsWith("route:")).toBe(true);
    expect(routingIdempotencyKey("custom-key-ok", long)).toBe("custom-key-ok");
  });

  it("refuses shared inference when dedicated Orchestration routing is required", () => {
    const shared: InferenceProvider = {
      async generate() {
        throw new Error("shared must not be called");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const route: InferenceRoute = {
      memoryProfile: "shared",
      alias: "qwen3-8b",
      operationalAlias: null,
      temperature: 0,
      maxOutputTokens: 128,
      timeoutMs: 1000,
      rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
      globalConcurrency: 1,
      departmentConcurrency: 1,
      dedicatedRouting: {
        enabled: true,
        instances: [],
        providerFor: () => shared,
      },
    };
    expect(() =>
      selectConversationInference({
        departmentId: "orch-id",
        departmentSlug: "orchestration",
        shared,
        route,
      }),
    ).toThrow(/No dedicated endpoint|unavailable/i);
  });

  it("rejects malformed orchestration output", () => {
    expect(orchestrationRouteSchema.safeParse({ primarySlug: "math" }).success).toBe(false);
    expect(
      orchestrationRouteSchema.safeParse({
        primarySlug: "math",
        additionalSlugs: [],
        rationale: "closed arithmetic",
        confidence: "high",
        approvalRequired: false,
      }).success,
    ).toBe(true);
  });

  it("marks bounded fallback as low-confidence when Orchestration fails", () => {
    const fallback = boundedFallbackDepartments("Explain the mathematics behind gravitational waves.", [
      { id: "1", slug: "math", name: "Math", status: "active" },
      { id: "2", slug: "science", name: "Science", status: "active" },
      { id: "3", slug: "research", name: "Research", status: "active" },
    ]);
    expect(fallback.primarySlug).toBe("math");
    expect(fallback.additionalSlugs).toContain("science");
    expect(fallback.confidence).toBe("low");
    expect(fallback.rationale).toMatch(/not a model decision/i);
  });

  it("adds an additive department routing migration", () => {
    const sql = readFileSync("packages/database/src/migrations/0022_department_routing.sql", "utf8");
    assertAdditiveMigration(sql);
    expect(sql).toContain('CREATE TABLE "department_routing_decisions"');
    expect(sql).toContain("idempotency_key");
    expect(sql.toLowerCase()).not.toContain("drop table");
  });

  it("adds an additive routing inference purpose migration", () => {
    const sql = readFileSync("packages/database/src/migrations/0023_routing_inference_purpose.sql", "utf8");
    assertAdditiveMigration(sql);
    expect(sql).toContain("routing");
    expect(sql.toLowerCase()).not.toContain("drop table");
  });

  it("adds an additive ad-hoc inference accounting migration", () => {
    const sql = readFileSync("packages/database/src/migrations/0024_adhoc_inference_accounting.sql", "utf8");
    assertAdditiveMigration(sql);
    expect(sql).toContain('ALTER COLUMN "objective_id" DROP NOT NULL');
    expect(sql).toContain("department_id");
    expect(sql).toContain("consumed_inference_requests");
    expect(sql.toLowerCase()).not.toContain("drop table");
  });

  it("adds dedicated colony inference token limits instead of reusing conversation tokens", () => {
    const sql = readFileSync("packages/database/src/migrations/0025_colony_inference_token_limits.sql", "utf8");
    assertAdditiveMigration(sql);
    expect(sql).toContain("max_inference_output_tokens");
    expect(sql).toContain("max_inference_estimated_tokens");
    expect(sql.toLowerCase()).not.toContain("drop table");
  });
});

describe("C1.7.1 routing budget accounting", () => {
  const objectiveId = "00000000-0000-4000-8000-000000000301";
  const scienceId = "00000000-0000-4000-8000-00000000001b";
  const mathId = "00000000-0000-4000-8000-000000000019";
  const orchId = "00000000-0000-4000-8000-000000000012";

  it("does not consume inference budget for deterministic arithmetic routing", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 1, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    let generateCalls = 0;
    const provider: InferenceProvider = {
      async generate() {
        generateCalls += 1;
        throw new Error("model must not run");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const result = await service.route(ctx(), provider, route(), {
      task: "What's 2 + 2?",
      objectiveId,
      idempotencyKey: "budget-det-0001",
    });
    expect(result.method).toBe("deterministic");
    expect(generateCalls).toBe(0);
    expect(harness.state.reserveCalls).toBe(0);
    expect(harness.state.reconcileCalls).toBe(0);
    expect(harness.state.insertUsageCalls).toBe(0);
  });

  it("consumes objective budget for successful Orchestration routing", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 2, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "Physics needs science and math.",
      confidence: "high",
      approvalRequired: false,
      inputTokens: 40,
      outputTokens: 20,
    });
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-ok-0001",
    });
    expect(result.method).toBe("model_assisted");
    expect(result.modelMetadata?.departmentSlug).toBe("orchestration");
    expect(result.modelMetadata?.budgetCharged).toBe(true);
    expect(result.modelMetadata?.inputTokens).toBe(40);
    expect(result.modelMetadata?.outputTokens).toBe(20);
    expect(harness.state.reserveCalls).toBe(1);
    expect(harness.state.insertInferenceCalls).toBe(1);
    expect(harness.state.insertUsageCalls).toBe(1);
    expect(harness.state.reconcileCalls).toBe(1);
    expect(harness.state.releaseCalls).toBe(0);
    expect(harness.state.consumedRequests).toBe(1);
    expect(harness.state.usages[0]).toMatchObject({ inputTokens: 40, outputTokens: 20, purpose: "routing" });
  });

  it("prevents model calls when the objective inference budget is exhausted", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 1, reservedRequests: 0, consumedRequests: 1 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    let generateCalls = 0;
    const provider: InferenceProvider = {
      async generate() {
        generateCalls += 1;
        throw new Error("must not generate");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    await expect(
      service.route(ctx(), provider, route(), {
        task: "Explain the mathematics behind gravitational waves.",
        objectiveId,
        idempotencyKey: "budget-ex-0001",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(generateCalls).toBe(0);
    expect(harness.state.decisions).toHaveLength(0);
  });

  it("does not convert budget denial into ordinary fallback seating", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 0, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    let generateCalls = 0;
    const provider: InferenceProvider = {
      async generate() {
        generateCalls += 1;
        throw new Error("must not generate after budget denial");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    await expect(
      service.route(ctx(), provider, route(), {
        task: "Design an autonomous research system.",
        idempotencyKey: "budget-deny-0001",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { budgetDenial: true } });
    expect(generateCalls).toBe(0);
    expect(harness.state.decisions).toHaveLength(0);
  });

  it("does not double-charge idempotent retries", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 4, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "Physics.",
      confidence: "high",
      approvalRequired: false,
      inputTokens: 11,
      outputTokens: 7,
    });
    const first = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-idem-0001",
    });
    const second = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-idem-0001",
    });
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.idempotentReplay).toBe(true);
    expect(harness.state.reserveCalls).toBe(1);
    expect(harness.state.reconcileCalls).toBe(1);
    expect(harness.state.insertUsageCalls).toBe(1);
    expect(harness.state.consumedRequests).toBe(1);
  });

  it("records known usage when the model returns but output validation fails", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 2, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider: InferenceProvider = {
      async generate() {
        return {
          text: "not-json",
          servedModel: "qwen3-8b",
          usage: { inputTokens: 15, outputTokens: 9, source: "observed" as const },
          latencyMs: 12,
        };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-fail-0001",
    });
    expect(result.method).toBe("fallback");
    expect(harness.state.insertUsageCalls).toBe(1);
    expect(harness.state.reconcileCalls).toBe(1);
    expect(harness.state.releaseCalls).toBe(0);
    expect(harness.state.consumedRequests).toBe(1);
    expect(harness.state.usages[0]).toMatchObject({ inputTokens: 15, outputTokens: 9 });
  });

  it("releases reservation without consuming when generate fails before usage is known", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 2, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider: InferenceProvider = {
      async generate() {
        throw new Error("provider unavailable");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-fail-0002",
    });
    expect(result.method).toBe("fallback");
    expect(harness.state.releaseCalls).toBe(1);
    expect(harness.state.reconcileCalls).toBe(0);
    expect(harness.state.consumedRequests).toBe(0);
  });

  it("prevents concurrent routing from exceeding the configured request budget", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 1, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    let releaseGate: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let reservedOnce: (() => void) | null = null;
    const sawReserve = new Promise<void>((resolve) => {
      reservedOnce = resolve;
    });
    const originalReserve = harness.state;
    const provider: InferenceProvider = {
      async generate() {
        reservedOnce?.();
        await blocked;
        return {
          text: JSON.stringify({
            primarySlug: "science",
            additionalSlugs: ["math"],
            rationale: "concurrent",
            confidence: "high",
            approvalRequired: false,
          }),
          servedModel: "qwen3-8b",
          usage: { inputTokens: 5, outputTokens: 5, source: "observed" as const },
          latencyMs: 1,
        };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    void originalReserve;
    const first = service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-conc-0001",
    });
    await sawReserve;
    const second = service.route(ctx(), provider, route(), {
      task: "Design an autonomous research system.",
      objectiveId,
      idempotencyKey: "budget-conc-0002",
    });
    await expect(second).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    releaseGate?.();
    const won = await first;
    expect(won.method).toBe("model_assisted");
    expect(harness.state.consumedRequests).toBe(1);
    expect(harness.state.reservedRequests).toBe(0);
  });

  function ctx(): RequestContext {
    return {
      actor: {
        principalId: "00000000-0000-4000-8000-000000000205",
        principalType: "agent",
        role: "department_agent",
        departmentId: scienceId,
        agentId: "00000000-0000-4000-8000-000000000205",
      },
      correlationId: "00000000-0000-4000-8000-000000000401",
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

  function orchestrationProvider(output: {
    primarySlug: string;
    additionalSlugs: string[];
    rationale: string;
    confidence: "high" | "medium" | "low";
    approvalRequired: boolean;
    inputTokens?: number;
    outputTokens?: number;
  }): InferenceProvider {
    return {
      async generate() {
        return {
          text: JSON.stringify({
            primarySlug: output.primarySlug,
            additionalSlugs: output.additionalSlugs,
            rationale: output.rationale,
            confidence: output.confidence,
            approvalRequired: output.approvalRequired,
          }),
          servedModel: "qwen3-8b",
          usage: {
            inputTokens: output.inputTokens ?? 10,
            outputTokens: output.outputTokens ?? 10,
            source: "observed",
          },
          latencyMs: 5,
        };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
  }

  it("charges colony budget for successful ad-hoc Orchestration routing", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 2, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "Physics needs science and math.",
      confidence: "high",
      approvalRequired: false,
      inputTokens: 33,
      outputTokens: 12,
    });
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-ok-0001",
    });
    expect(result.method).toBe("model_assisted");
    expect(result.modelMetadata?.budgetScope).toBe("colony");
    expect(result.modelMetadata?.departmentId).toBe(orchId);
    expect(harness.state.reserveCalls).toBe(1);
    expect(harness.state.lastReserveObjectiveId).toBeNull();
    expect(harness.state.lastInferenceDepartmentId).toBe(orchId);
    expect(harness.state.colonyConsumed).toBe(1);
    expect(harness.state.consumedRequests).toBe(0);
    expect(harness.state.insertUsageCalls).toBe(1);
  });

  it("denies ad-hoc routing when the colony inference budget is exhausted", async () => {
    const harness = budgetHarness({
      maxInferenceRequests: 1,
      reservedRequests: 0,
      consumedRequests: 0,
      colonyConsumed: 1,
    });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    let generateCalls = 0;
    const provider: InferenceProvider = {
      async generate() {
        generateCalls += 1;
        throw new Error("must not generate");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    await expect(
      service.route(ctx(), provider, route(), {
        task: "Explain the mathematics behind gravitational waves.",
        idempotencyKey: "budget-adhoc-ex-0001",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { budgetDenial: true, scope: "colony" } });
    expect(generateCalls).toBe(0);
    expect(harness.state.decisions).toHaveLength(0);
  });

  it("prevents concurrent ad-hoc routing from exceeding the colony request budget", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 1, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    let releaseGate: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let reservedOnce: (() => void) | null = null;
    const sawReserve = new Promise<void>((resolve) => {
      reservedOnce = resolve;
    });
    const provider: InferenceProvider = {
      async generate() {
        reservedOnce?.();
        await blocked;
        return {
          text: JSON.stringify({
            primarySlug: "science",
            additionalSlugs: ["math"],
            rationale: "concurrent ad-hoc",
            confidence: "high",
            approvalRequired: false,
          }),
          servedModel: "qwen3-8b",
          usage: { inputTokens: 5, outputTokens: 5, source: "observed" as const },
          latencyMs: 1,
        };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const first = service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-conc-0001",
    });
    await sawReserve;
    await expect(
      service.route(ctx(), provider, route(), {
        task: "Design an autonomous research system.",
        idempotencyKey: "budget-adhoc-conc-0002",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    releaseGate?.();
    const won = await first;
    expect(won.method).toBe("model_assisted");
    expect(harness.state.colonyConsumed).toBe(1);
    expect(harness.state.colonyReserved).toBe(0);
  });

  it("does not double-charge ad-hoc idempotent retries", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 4, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "Physics.",
      confidence: "high",
      approvalRequired: false,
      inputTokens: 8,
      outputTokens: 4,
    });
    const first = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-idem-0001",
    });
    const second = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-idem-0001",
    });
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.idempotentReplay).toBe(true);
    expect(harness.state.reserveCalls).toBe(1);
    expect(harness.state.colonyConsumed).toBe(1);
  });

  it("records known ad-hoc usage when output is malformed", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 2, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider: InferenceProvider = {
      async generate() {
        return {
          text: "not-json",
          servedModel: "qwen3-8b",
          usage: { inputTokens: 21, outputTokens: 6, source: "observed" as const },
          latencyMs: 8,
        };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-malformed-0001",
    });
    expect(result.method).toBe("fallback");
    expect(harness.state.colonyConsumed).toBe(1);
    expect(harness.state.usages[0]).toMatchObject({ inputTokens: 21, outputTokens: 6 });
  });

  it("releases ad-hoc reservation when the provider fails before usage is known", async () => {
    const harness = budgetHarness({ maxInferenceRequests: 2, reservedRequests: 0, consumedRequests: 0 });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider: InferenceProvider = {
      async generate() {
        throw new Error("provider unavailable");
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-fail-0001",
    });
    expect(result.method).toBe("fallback");
    expect(harness.state.releaseCalls).toBe(1);
    expect(harness.state.colonyConsumed).toBe(0);
    expect(harness.state.colonyReserved).toBe(0);
  });

  it("recovers a stale running reservation without double-reserving", async () => {
    // Prior consumed slot + held stale reservation already fill max=2; reclaim must not demand a third slot.
    const harness = budgetHarness({
      maxInferenceRequests: 2,
      reservedRequests: 0,
      consumedRequests: 0,
      colonyConsumed: 1,
      colonyReserved: 1,
      colonyMaxInferenceRequests: 2,
    });
    harness.state.inferences.set("routing:budget-adhoc-stale-0001", {
      id: "00000000-0000-4000-8000-000000000901",
      status: "running",
      reservedOutputTokens: 400,
      responseText: null,
      leaseUntil: "2026-06-05T00:00:00.000Z",
      departmentId: orchId,
      objectiveId: null,
    });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "recovered",
      confidence: "high",
      approvalRequired: false,
      inputTokens: 4,
      outputTokens: 3,
    });
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      idempotencyKey: "budget-adhoc-stale-0001",
    });
    expect(result.method).toBe("model_assisted");
    expect(harness.state.reserveCalls).toBe(0);
    expect(harness.state.reopenCalls).toBe(1);
    expect(harness.state.colonyConsumed).toBe(2);
    expect(harness.state.colonyReserved).toBe(0);
  });

  it("keeps objective-linked routing on the objective budget after ad-hoc accounting exists", async () => {
    const harness = budgetHarness({
      maxInferenceRequests: 2,
      reservedRequests: 0,
      consumedRequests: 0,
      colonyConsumed: 1,
      colonyMaxInferenceRequests: 1,
    });
    const service = new DepartmentRoutingService(harness.persistence, new Authorizer(), () => new Date("2026-06-06T00:00:00.000Z"));
    const provider = orchestrationProvider({
      primarySlug: "science",
      additionalSlugs: ["math"],
      rationale: "still objective scoped",
      confidence: "high",
      approvalRequired: false,
      inputTokens: 9,
      outputTokens: 5,
    });
    const result = await service.route(ctx(), provider, route(), {
      task: "Explain the mathematics behind gravitational waves.",
      objectiveId,
      idempotencyKey: "budget-compat-0001",
    });
    expect(result.method).toBe("model_assisted");
    expect(result.modelMetadata?.budgetScope).toBe("objective");
    expect(harness.state.consumedRequests).toBe(1);
    expect(harness.state.colonyConsumed).toBe(1);
  });

  function budgetHarness(seed: {
    maxInferenceRequests: number;
    reservedRequests: number;
    consumedRequests: number;
    colonyConsumed?: number;
    colonyReserved?: number;
    colonyMaxInferenceRequests?: number;
  }) {
    const state = {
      reserveCalls: 0,
      releaseCalls: 0,
      reconcileCalls: 0,
      insertInferenceCalls: 0,
      insertUsageCalls: 0,
      reopenCalls: 0,
      consumedRequests: seed.consumedRequests,
      reservedRequests: seed.reservedRequests,
      colonyConsumed: seed.colonyConsumed ?? 0,
      colonyReserved: seed.colonyReserved ?? 0,
      lastReserveObjectiveId: undefined as string | null | undefined,
      lastInferenceDepartmentId: null as string | null,
      decisions: [] as Array<{ id: string; idempotencyKey: string }>,
      inferences: new Map<
        string,
        {
          id: string;
          status: string;
          reservedOutputTokens: number;
          responseText: string | null;
          leaseUntil: string | null;
          departmentId: string | null;
          objectiveId: string | null;
        }
      >(),
      usages: [] as Array<{ inputTokens: number | null; outputTokens: number | null; purpose: string }>,
      maxInferenceRequests: seed.maxInferenceRequests,
      colonyMaxInferenceRequests: seed.colonyMaxInferenceRequests ?? seed.maxInferenceRequests,
    };
    const departments = {
      async list() {
        return {
          data: [
            { id: scienceId, slug: "science", name: "Science", status: "active" },
            { id: mathId, slug: "math", name: "Math", status: "active" },
            { id: orchId, slug: "orchestration", name: "Orchestration", status: "active" },
            { id: "00000000-0000-4000-8000-000000000018", slug: "research", name: "Research", status: "active" },
          ],
          nextCursor: null,
        };
      },
    };
    const objectives = {
      async getRun(id: string) {
        if (id !== objectiveId) {
          return null;
        }
        return {
          id: objectiveId,
          limits: {
            maxInferenceRequests: state.maxInferenceRequests,
            maxOutputTokens: 8_000,
            maxEstimatedTokens: 32_000,
            maxTaskAttempts: 2,
            maxConcurrentTasks: 2,
            maxDurationMs: 60_000,
          },
          consumedRequests: state.consumedRequests,
          reservedRequests: state.reservedRequests,
          consumedOutputTokens: 0,
          estimatedOutputTokens: 0,
          reservedOutputTokens: 0,
          estimatedInputTokens: 0,
        };
      },
      async reserve(input: { objectiveId: string | null; outputTokens: number; estimatedTokens: number }) {
        state.reserveCalls += 1;
        state.lastReserveObjectiveId = input.objectiveId;
        if (!input.objectiveId) {
          if (state.colonyConsumed + state.colonyReserved + 1 > state.colonyMaxInferenceRequests) {
            return false;
          }
          state.colonyReserved += 1;
          return true;
        }
        if (state.consumedRequests + state.reservedRequests + 1 > state.maxInferenceRequests) {
          return false;
        }
        state.reservedRequests += 1;
        return true;
      },
      async releaseReservation(scope: string | null) {
        state.releaseCalls += 1;
        if (!scope) {
          state.colonyReserved = Math.max(0, state.colonyReserved - 1);
          return;
        }
        state.reservedRequests = Math.max(0, state.reservedRequests - 1);
      },
      async reconcile(input: { objectiveId: string | null }) {
        state.reconcileCalls += 1;
        if (!input.objectiveId) {
          state.colonyReserved = Math.max(0, state.colonyReserved - 1);
          state.colonyConsumed += 1;
          return;
        }
        state.reservedRequests = Math.max(0, state.reservedRequests - 1);
        state.consumedRequests += 1;
      },
      async insertInference(input: {
        id: string;
        idempotencyKey: string;
        reservedOutputTokens: number;
        purpose: string;
        departmentId?: string | null;
        objectiveId: string | null;
      }) {
        state.insertInferenceCalls += 1;
        state.lastInferenceDepartmentId = input.departmentId ?? null;
        if (state.inferences.has(input.idempotencyKey)) {
          return "exists";
        }
        state.inferences.set(input.idempotencyKey, {
          id: input.id,
          status: "running",
          reservedOutputTokens: input.reservedOutputTokens,
          responseText: null,
          leaseUntil: "2026-06-06T00:01:00.000Z",
          departmentId: input.departmentId ?? null,
          objectiveId: input.objectiveId,
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
              responseText: row.responseText,
              purpose: "routing",
              leaseUntil: row.leaseUntil,
              departmentId: row.departmentId,
              objectiveId: row.objectiveId,
            }
          : null;
      },
      async reopenInference(id: string) {
        state.reopenCalls += 1;
        for (const [key, row] of state.inferences) {
          if (row.id === id) {
            state.inferences.set(key, {
              ...row,
              status: "running",
              responseText: null,
              leaseUntil: "2026-06-06T00:01:00.000Z",
            });
          }
        }
      },
      async finishInference(id: string, patch: { status: string; responseText: string | null }) {
        for (const [key, row] of state.inferences) {
          if (row.id === id) {
            state.inferences.set(key, {
              ...row,
              status: patch.status,
              responseText: patch.responseText,
            });
          }
        }
      },
      async insertUsage(input: { inputTokens: number | null; outputTokens: number | null }) {
        state.insertUsageCalls += 1;
        state.usages.push({ ...input, purpose: "routing" });
      },
    };
    const departmentRouting = {
      async findByIdempotencyKey(key: string) {
        const found = state.decisions.find((row) => row.idempotencyKey === key);
        return found
          ? {
              id: found.id,
              idempotencyKey: found.idempotencyKey,
              taskText: "task",
              objectiveId: null,
              method: "model_assisted",
              primaryDepartmentId: scienceId,
              recommendedDepartmentIds: [scienceId, mathId],
              rejectedRecommendations: [],
              finalParticipantIds: [scienceId, mathId],
              rationale: "cached",
              confidence: "high",
              uncertainty: null,
              approvalRequired: false,
              modelMetadata: { departmentSlug: "orchestration", budgetCharged: true },
              fallbackReason: null,
              createdBy: "x",
              correlationId: "y",
              createdAt: "2026-06-06T00:00:00.000Z",
            }
          : null;
      },
      async findById() {
        return null;
      },
      async insert(record: { id: string; idempotencyKey: string }) {
        state.decisions.push({ id: record.id, idempotencyKey: record.idempotencyKey });
        return record;
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
    };
    const audit = {
      async append() {
        return undefined;
      },
    };
    const repos = { departments, objectives, departmentRouting, autonomy, audit };
    const persistence = {
      repos,
      async transaction(work: (repos: typeof repos) => Promise<unknown>) {
        return work(repos);
      },
      async ping() {
        return undefined;
      },
      async close() {
        return undefined;
      },
    } as unknown as Persistence;
    return { persistence, state };
  }
});


