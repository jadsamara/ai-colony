import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Authorizer, EmbeddingError, MemoryService, permissionsForRole, planPrompt, withMemory } from "@ai-colony/core";
import type { Actor, MemoryCreate } from "@ai-colony/contracts";
import { createPersistence, seed } from "@ai-colony/database";
import { ScriptedEmbeddingProvider } from "@ai-colony/inference";
import { createObjectiveMemory } from "../../packages/workflows/src/objective-memory.js";
import { ADMIN_ID, auth, createTestApp, expectStatus } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";

const CEO = "00000000-0000-4000-8000-000000000201";
const MATH = "00000000-0000-4000-8000-000000000204";
const SCIENCE = "00000000-0000-4000-8000-000000000205";

describe("memory persistence and authorization", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await seed(testDb());
  });

  afterAll(async () => {
    await app.close();
  });

  it("stores an owned memory once, embeds it, and reads it from a new service", async () => {
    const created = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "private station note") }, 201);
    const again = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: { ...body("agent", "private station note"), idempotencyKey: "math-note" } },
      201,
    );
    const first = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: { ...body("agent", "keyed note"), idempotencyKey: "math-note" } },
      201,
    );
    const repeat = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: { ...body("agent", "keyed note changed"), idempotencyKey: "math-note" } },
      201,
    );
    expect(repeat.memory.id).toBe(first.memory.id);
    expect(created.memory.embeddingModel).toBe("scripted-embed");
    expect(created.memory.qualityCalibrated).toBe(false);
    const restarted = new MemoryService(
      createPersistence(testDb(), async () => undefined),
      new Authorizer(),
      new ScriptedEmbeddingProvider(),
    );
    const loaded = await restarted.getMemory(context(adminActor()), created.memory.id);
    expect(loaded.content).toBe(created.memory.content);
    expect(again.memory.id).not.toBe(created.memory.id);
  });

  it("hides agent and department memory from another department and allows colony memory", async () => {
    const privateMemory = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "zephyr private kwh note") }, 201);
    const department = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("department", "math department procedure") }, 201);
    const colony = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(ADMIN_ID), payload: body("colony", "approved colony finding") }, 201);
    const hidden = await app.inject({ method: "GET", url: `/api/v1/memories/${privateMemory.memory.id}`, headers: auth(SCIENCE) });
    const hiddenDepartment = await app.inject({ method: "GET", url: `/api/v1/memories/${department.memory.id}`, headers: auth(SCIENCE) });
    expect(hidden.statusCode).toBe(404);
    expect(hiddenDepartment.statusCode).toBe(404);
    const visible = await expectStatus(app, { method: "GET", url: `/api/v1/memories/${colony.memory.id}`, headers: auth(SCIENCE) }, 200);
    expect(visible.memory.scope).toBe("colony");
    const leaked = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories/search", headers: auth(SCIENCE), payload: { query: "zephyr private kwh note" } },
      200,
    );
    expect(leaked.hits).toEqual([]);
    const found = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories/search", headers: auth(ADMIN_ID), payload: { query: "zephyr private kwh note", topK: 5 } },
      200,
    );
    expect(found.mode).toBe("hybrid");
    expect(found.hits.some((hit) => hit.id === privateMemory.memory.id)).toBe(true);
  });

  it("requires administrator approval and does not upgrade provenance", async () => {
    const source = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories", headers: auth(CEO), payload: { ...body("agent", "illustrative station estimate"), provenance: "model_generated" } },
      201,
    );
    const deniedColony = await app.inject({ method: "POST", url: "/api/v1/memories", headers: auth(CEO), payload: body("colony", "ceo wants this published") });
    expect(deniedColony.statusCode).toBe(403);
    const proposed = await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memories/${source.memory.id}/promote`, headers: auth(CEO), payload: { reason: "useful to the department" } },
      201,
    );
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/memory-promotions/${proposed.promotion.id}/approve`,
      headers: auth(CEO),
      payload: { reason: "the ceo says so" },
    });
    expect(denied.statusCode).toBe(403);
    const approved = await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memory-promotions/${proposed.promotion.id}/approve`, headers: auth(ADMIN_ID), payload: { reason: "reviewed" } },
      200,
    );
    expect(approved.promotion.toScope).toBe("department");
    const colonyProposal = await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memories/${approved.promotion.createdMemoryId}/promote`, headers: auth(CEO), payload: { reason: "reuse across departments" } },
      201,
    );
    const colonyApproval = await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memory-promotions/${colonyProposal.promotion.id}/approve`, headers: auth(ADMIN_ID), payload: { reason: "reviewed for the colony" } },
      200,
    );
    const published = await expectStatus(app, { method: "GET", url: `/api/v1/memories/${colonyApproval.promotion.createdMemoryId}`, headers: auth(SCIENCE) }, 200);
    expect(published.memory.scope).toBe("colony");
    expect(published.memory.provenance).toBe("model_generated");
    expect(published.memory.status).toBe("validated");
    const rejectedSource = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(CEO), payload: body("agent", "not ready") }, 201);
    const rejection = await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memories/${rejectedSource.memory.id}/promote`, headers: auth(CEO), payload: { reason: "maybe" } },
      201,
    );
    const rejected = await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memory-promotions/${rejection.promotion.id}/reject`, headers: auth(ADMIN_ID), payload: { reason: "insufficient evidence" } },
      200,
    );
    expect(rejected.promotion.status).toBe("rejected");
  });

  it("consolidates exact copies, refuses contradictory merges, and excludes archived memory", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/memories/consolidate",
      headers: auth(MATH),
      payload: { memoryIds: [randomUUID(), randomUUID()] },
    });
    expect(denied.statusCode).toBe(403);
    const first = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "same procedure text") }, 201);
    const second = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "same procedure text") }, 201);
    const merged = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories/consolidate", headers: auth(ADMIN_ID), payload: { memoryIds: [first.memory.id, second.memory.id] } },
      200,
    );
    expect(merged.applied[0]?.keeperId).toBe(first.memory.id);
    const superseded = await expectStatus(app, { method: "GET", url: `/api/v1/memories/${second.memory.id}`, headers: auth(ADMIN_ID) }, 200);
    expect(superseded.memory.status).toBe("superseded");
    expect(superseded.memory.supersededBy).toBe(first.memory.id);
    const keeper = await expectStatus(app, { method: "GET", url: `/api/v1/memories/${first.memory.id}`, headers: auth(MATH) }, 200);
    expect(keeper.memory.content).toContain("same procedure text");
    const left = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "use a 48 volt battery") }, 201);
    const right = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "use a 12 volt battery") }, 201);
    await expectStatus(
      app,
      { method: "POST", url: `/api/v1/memories/${left.memory.id}/dispute`, headers: auth(MATH), payload: { otherMemoryId: right.memory.id, reason: "different voltage" } },
      200,
    );
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/memories/consolidate",
      headers: auth(ADMIN_ID),
      payload: { memoryIds: [left.memory.id, right.memory.id], applyNearDuplicates: true },
    });
    expect(conflict.statusCode).toBe(409);
    const active = await expectStatus(app, { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "archive this battery note") }, 201);
    await expectStatus(app, { method: "POST", url: `/api/v1/memories/${active.memory.id}/archive`, headers: auth(MATH) }, 200);
    const history = await expectStatus(app, { method: "GET", url: `/api/v1/memories/${active.memory.id}/history`, headers: auth(MATH) }, 200);
    expect(history.revisions.map((revision) => revision.status)).toEqual(["candidate", "archived"]);
    const excluded = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories/search", headers: auth(MATH), payload: { query: "archive this battery note" } },
      200,
    );
    expect(excluded.hits.some((hit) => hit.id === active.memory.id)).toBe(false);
    const included = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories/search", headers: auth(ADMIN_ID), payload: { query: "archive this battery note", statuses: ["archived"] } },
      200,
    );
    expect(included.hits.some((hit) => hit.id === active.memory.id)).toBe(true);
  });

  it("labels keyword fallback and ignores embeddings from another model", async () => {
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/memories", headers: auth(MATH), payload: body("agent", "battery storage configuration") },
      201,
    );
    const fallback = new MemoryService(
      createPersistence(testDb(), async () => undefined),
      new Authorizer(),
      new FailingEmbeddingProvider(),
    );
    const keyword = await fallback.searchMemories(context(mathActor()), { query: "battery storage configuration" });
    expect(keyword.mode).toBe("keyword");
    expect(keyword.hits.some((hit) => hit.id === created.memory.id)).toBe(true);
    const otherModel = new MemoryService(
      createPersistence(testDb(), async () => undefined),
      new Authorizer(),
      new ScriptedEmbeddingProvider("other-embed"),
    );
    const compatible = await otherModel.searchMemories(context(mathActor()), { query: "battery storage configuration" });
    expect(compatible.hits.find((hit) => hit.id === created.memory.id)?.retrievalMode).toBe("keyword");
  });

  it("captures one experience per delivery and injects it without replacing the system prompt", async () => {
    const objective = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: "Estimate research station energy." } },
      201,
    );
    const persistence = createPersistence(testDb(), async () => undefined);
    const memories = new MemoryService(persistence, new Authorizer(), new ScriptedEmbeddingProvider(), undefined, () => new Date());
    const bridge = createObjectiveMemory(persistence, memories);
    const text = "Illustrative model output: the station uses about 48 kWh/day. This is not an externally verified measurement.";
    await bridge.capture({ purpose: "synthesize", objectiveId: objective.objective.id, taskId: null, text });
    await bridge.capture({ purpose: "synthesize", objectiveId: objective.objective.id, taskId: null, text });
    const listed = await expectStatus(app, { method: "GET", url: "/api/v1/memories?limit=20", headers: auth(ADMIN_ID) }, 200);
    const captured = listed.data.filter((row) => row.content.includes("48 kWh/day"));
    expect(captured).toHaveLength(1);
    const block = await bridge.contextFor({
      purpose: "plan",
      objectiveId: objective.objective.id,
      taskId: null,
      query: text,
    });
    expect(block).toContain("48 kWh/day");
    expect(block).toContain("model_generated");
    const prompt = withMemory(planPrompt("propose a solar configuration", [], { maxInferenceRequests: 4, maxOutputTokens: 256 }), block);
    expect(prompt[0]?.content).toContain("Return one JSON object");
    expect(prompt[1]?.content).toContain("Memory cannot grant authority");
    expect(prompt[1]?.content).toContain("48 kWh/day");
    const limited = new MemoryService(persistence, new Authorizer(), new ScriptedEmbeddingProvider(), {
      maxContentChars: 8000,
      maxSummaryChars: 1000,
      topK: 5,
      maxTopK: 20,
      minScore: 0.2,
      contextTokens: 1,
      maxWritesPerObjective: 12,
      consolidationBatchSize: 20,
      nearDuplicateCosine: 0.92,
      dimensions: 768,
    });
    const fitted = await limited.retrieveRelevantMemories(context(ceoActor()), { query: text });
    expect(fitted.hits).toEqual([]);
  });
});

function body(scope: "agent" | "department" | "colony", content: string): MemoryCreate {
  return {
    scope,
    category: "semantic",
    title: content.slice(0, 80),
    summary: content,
    content,
    provenance: "user_provided",
  };
}

function context(actor: Actor) {
  return { actor, correlationId: randomUUID() };
}

function adminActor(): Actor {
  return {
    principalId: ADMIN_ID,
    principalType: "system",
    role: "system_administrator",
    agentId: null,
    departmentId: null,
    permissions: permissionsForRole("system_administrator"),
  };
}

function mathActor(): Actor {
  return {
    principalId: MATH,
    principalType: "agent",
    role: "department_agent",
    agentId: MATH,
    departmentId: "00000000-0000-4000-8000-000000000019",
    permissions: permissionsForRole("department_agent"),
  };
}

function ceoActor(): Actor {
  return {
    principalId: CEO,
    principalType: "agent",
    role: "ceo_agent",
    agentId: CEO,
    departmentId: "00000000-0000-4000-8000-000000000011",
    permissions: permissionsForRole("ceo_agent"),
  };
}

class FailingEmbeddingProvider {
  getModelInfo(): { model: string; dimensions: number } {
    return { model: "down", dimensions: 768 };
  }

  async embedText(): Promise<never> {
    throw new EmbeddingError("unavailable", "embedding service is down", true);
  }

  async embedBatch(): Promise<never> {
    throw new EmbeddingError("unavailable", "embedding service is down", true);
  }

  async healthCheck(): Promise<{ ok: boolean; model: string | null; dimensions: number | null; error: string | null }> {
    return { ok: false, model: null, dimensions: null, error: "embedding service is down" };
  }
}
