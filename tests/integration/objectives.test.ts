import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  MessagingService,
  ObjectiveService,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createPersistence, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { handleDelivery, publishOutboxBatch, ScriptedTransport } from "@ai-colony/messaging";
import { openCheckpointer } from "@ai-colony/workflows";
import { compileCeoGraph, compileOrchestrationGraph } from "@ai-colony/workflows";
import { objectiveMessageHandler } from "@ai-colony/workflows";
import { runCeoPass, runOrchestrationPass } from "@ai-colony/workflows";
import { ADMIN_ID, auth, createTestApp, expectStatus } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

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

const plan = {
  summary: "Compare solar and wind for a remote station",
  tasks: [
    {
      localId: "math-load",
      departmentSlug: "math",
      taskType: "math",
      objective: "Calculate an illustrative daily energy requirement",
      expectedOutput: "A numeric estimate",
      dependsOn: [],
    },
    {
      localId: "research-evidence",
      departmentSlug: "research",
      taskType: "research",
      objective: "Separate model knowledge from verified evidence",
      expectedOutput: "Evidence limits",
      dependsOn: [],
    },
    {
      localId: "science-tradeoff",
      departmentSlug: "science",
      taskType: "science",
      objective: "Identify engineering tradeoffs",
      expectedOutput: "Tradeoffs",
      dependsOn: ["math-load"],
    },
  ],
  completionCriteria: ["The estimate and tradeoffs are both present"],
  estimatedResources: { inferenceRequests: 6, outputTokens: 2000 },
  risks: ["No site measurements are available"],
};

describe("objective workflows", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  const authorizer = new Authorizer();
  let checkpointer: Awaited<ReturnType<typeof openCheckpointer>>;

  beforeAll(async () => {
    checkpointer = await openCheckpointer(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await checkpointer.end();
  });

  it("plans, dispatches through the outbox, and synthesizes scripted specialist results", async () => {
    await seed(testDb());
    const provider = scriptedProvider();
    const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY);
    const objectives = new ObjectiveService(persistence, authorizer, messages);
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: {
          objective:
            "Compare solar and wind energy for powering a small remote research station. Calculate a simple illustrative energy requirement and identify important engineering tradeoffs.",
          limits: { maxConcurrentTasks: 2 },
        },
      },
      201,
    );
    const objectiveId = created.objective.id as string;
    const graph = compileCeoGraph({
      service: objectives,
      provider,
      route,
      workerId: "ceo-test",
      checkpointer,
    });
    await runCeoPass(graph, objectives);
    const scheduled = await objectives.get(admin(), objectiveId);
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.executionAuthorized).toBe(true);
    expect(provider.requests.filter((request) => request.jsonObject)).toHaveLength(1);
    const checkpoint = await graph.getState({ configurable: { thread_id: `ceo:${objectiveId}` } });
    expect(checkpoint.values.objectiveId).toBe(objectiveId);

    await runCeoPass(graph, objectives);
    expect(provider.requests.filter((request) => request.jsonObject)).toHaveLength(1);

    const orchestration = compileOrchestrationGraph({
      service: objectives,
      route,
      workerId: "orchestration-test",
      checkpointer,
    });
    await runOrchestrationPass(orchestration, randomUUID());
    const firstWave = await deliver(objectives, provider, "specialist");
    expect(firstWave).toBe(2);
    await runOrchestrationPass(orchestration, randomUUID());
    await deliver(objectives, provider, "orchestration");
    await runOrchestrationPass(orchestration, randomUUID());
    const secondWave = await deliver(objectives, provider, "specialist");
    expect(secondWave).toBe(1);
    await deliver(objectives, provider, "orchestration");

    await runCeoPass(graph, objectives);
    const completed = await objectives.get(admin(), objectiveId);
    expect(completed.status).toBe("completed");
    expect(completed.finalOutput).toContain("ILLUSTRATIVE-KWH");
    const tasks = await objectives.tasks(admin(), objectiveId);
    expect(tasks.map((task) => task.status).sort()).toEqual(["completed", "completed", "completed"]);
    expect(tasks.find((task) => task.taskType === "research")?.resultSummary).toMatch(/model knowledge only/);
    const models = await expectStatus(app, { method: "GET", url: "/api/v1/models", headers: auth(ADMIN_ID) }, 200);
    expect(models.data.every((model: { status: string }) => model.status === "not_deployed")).toBe(true);
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/objectives/${objectiveId}`,
      headers: auth("00000000-0000-4000-8000-000000000204"),
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("stops replanning after the correction limit and cancels before dispatch", async () => {
    await seed(testDb());
    const provider = new ScriptedInferenceProvider(() => ({
      text: "not json",
      servedModel: "qwen3-8b",
      usage: { inputTokens: null, outputTokens: null, source: "unavailable" },
      latencyMs: 1,
    }));
    const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY);
    const objectives = new ObjectiveService(persistence, authorizer, messages);
    const created = await objectives.submit(admin(), { objective: "This plan will stay invalid." });
    const graph = compileCeoGraph({
      service: objectives,
      provider,
      route,
      workerId: "ceo-invalid",
      checkpointer,
    });
    await runCeoPass(graph, objectives);
    const failed = await objectives.get(admin(), created.id);
    expect(failed.status).toBe("failed");
    expect(provider.requests).toHaveLength(3);

    const cancelled = await objectives.submit(admin(), { objective: "Cancel me before planning." });
    const stopped = await objectives.cancel(admin(), cancelled.id);
    expect(stopped.status).toBe("cancelled");
    const graph2 = compileCeoGraph({
      service: objectives,
      provider,
      route,
      workerId: "ceo-cancel",
      checkpointer,
    });
    const calls = provider.requests.length;
    await runCeoPass(graph2, objectives);
    expect(provider.requests).toHaveLength(calls);
  });

  it("exhausts a one-request budget and reports monitoring findings", async () => {
    await seed(testDb());
    const provider = scriptedProvider();
    const messages = new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY);
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const objectives = new ObjectiveService(persistence, authorizer, messages, () => new Date(clock));
    const created = await objectives.submit(admin(), {
      objective: "Stay inside a one-request budget.",
      limits: { maxInferenceRequests: 1, maxConcurrentTasks: 1 },
    });
    const graph = compileCeoGraph({
      service: objectives,
      provider,
      route: { ...route, globalConcurrency: 1 },
      workerId: "ceo-budget",
      checkpointer,
    });
    await runCeoPass(graph, objectives);
    const orchestration = compileOrchestrationGraph({
      service: objectives,
      route: { ...route, globalConcurrency: 1 },
      workerId: "orchestration-budget",
      checkpointer,
    });
    await runOrchestrationPass(orchestration, randomUUID());
    await deliver(objectives, provider, "specialist");
    const failed = await objectives.get(admin(), created.id);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/budget/);

    await objectives.recordProbe({
      modelId: "00000000-0000-4000-8000-000000000101",
      endpointUrl: "http://127.0.0.1:8080",
      expectedAlias: "qwen3-8b",
      reachable: false,
      modelIds: [],
      error: "connection refused",
    });
    await objectives.heartbeat("worker-test", "specialist", null);
    clock += 60_000;
    const overview = await objectives.overview(admin(), 1000);
    expect(overview.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["model_unavailable", "worker_stale"]),
    );
    expect(overview.models.find((model) => model.displayName === "Qwen3-8B")?.runtimeStatus).toBe("unavailable");
    expect(overview.models.find((model) => model.displayName === "Qwen3-4B")?.runtimeStatus).toBe("not_deployed");
  });
});

function scriptedProvider(): ScriptedInferenceProvider {
  return new ScriptedInferenceProvider((request) => {
    const system = request.messages[0]?.content ?? "";
    const text = system.includes("JSON object")
      ? JSON.stringify(plan)
      : system.includes("Synthesize")
        ? "Final comparison using specialist results. ILLUSTRATIVE-KWH is an illustrative figure, not a measurement."
        : "Specialist result for the remote station.";
    return {
      text,
      servedModel: request.modelAlias,
      usage: { inputTokens: 12, outputTokens: 24, source: "observed" },
      latencyMs: 2,
    };
  });
}

async function deliver(
  objectives: ObjectiveService,
  provider: ScriptedInferenceProvider,
  role: "specialist" | "orchestration",
): Promise<number> {
  const persistence = createPersistence(testDb(), async () => undefined);
  const transport = new ScriptedTransport();
  const messages = new MessagingService(
    persistence,
    new Authorizer(),
    DEFAULT_MESSAGING_POLICY,
    objectiveMessageHandler({
      service: objectives,
      provider,
      route,
      workerId: `${role}-delivery`,
      role,
    }),
  );
  await transport.connect();
  const published = await publishOutboxBatch({
    persistence,
    transport,
    workerId: "publisher-test",
    policy: DEFAULT_MESSAGING_POLICY,
  });
  for (const message of transport.published.splice(0, transport.published.length)) {
    await handleDelivery(messages, `${role}-delivery`, {
      routingKey: message.routingKey,
      body: message.body,
      ack: async () => undefined,
      nack: async () => undefined,
    });
  }
  return published;
}

function admin(): RequestContext {
  return {
    correlationId: "test",
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
