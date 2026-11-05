import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ADMINISTRATOR_ID, type Message } from "@ai-colony/contracts";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  InferenceError,
  MessagingService,
  ObjectiveService,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { createDatabase, createPersistence, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { handleDelivery, publishOutboxBatch, ScriptedTransport } from "@ai-colony/messaging";
import {
  compileCeoGraph,
  compileOrchestrationGraph,
  objectiveMessageHandler,
  openCheckpointer,
  runCeoPass,
  runOrchestrationPass,
} from "@ai-colony/workflows";
import { ADMIN_ID, auth, createTestApp, expectStatus } from "../helpers/app.js";
import { testDb } from "../helpers/db.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

const ARITHMETIC = "Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer.";
const REASONING = "Check this argument for a contradiction in the premise that one department is both idle and busy.";
const AMBIGUOUS = "Help me figure out what the colony should do next.";
const LIGHTWEIGHT = "Calculate 12 times 4 and check whether the statement contains a contradiction.";
const MATH_AGENT_PRINCIPAL = "00000000-0000-4000-8000-000000000204";

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

const fallbackPlan = {
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

describe("efficiency routing", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  const authorizer = new Authorizer();
  let checkpointer: Awaited<ReturnType<typeof openCheckpointer>>;

  beforeAll(async () => {
    checkpointer = await openCheckpointer(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await checkpointer.end();
  });

  it("answers arithmetic with one math inference and no CEO inference", async () => {
    await seed(testDb());
    const provider = specialistProvider("17 multiplied by 23 is 391.");
    const objectives = new ObjectiveService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
    const app = await createTestApp();
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/objectives",
      headers: auth(MATH_AGENT_PRINCIPAL),
      payload: { objective: ARITHMETIC },
    });
    expect(denied.statusCode).toBe(403);

    const created = await expectStatus(
      app,
      {
        method: "POST",
        url: "/api/v1/objectives",
        headers: auth(ADMIN_ID),
        payload: { objective: ARITHMETIC },
      },
      201,
    );
    const objectiveId = created.objective.id as string;
    const graph = compileCeoGraph({ service: objectives, provider, route, workerId: "ceo-test", checkpointer });
    await runCeoPass(graph, objectives);
    expect(provider.requests).toHaveLength(0);
    expect((await objectives.get(admin(), objectiveId)).status).toBe("scheduled");

    const orchestration = compileOrchestrationGraph({
      service: objectives,
      route,
      workerId: "orchestration-test",
      checkpointer,
    });
    await runOrchestrationPass(orchestration, randomUUID());
    expect((await deliver(objectives, provider, "specialist")).published).toBe(1);
    const resultDelivery = await deliver(objectives, provider, "orchestration");
    const result = resultDelivery.bodies
      .map((body) => JSON.parse(body.toString("utf8")) as Message)
      .find((message) => message.messageType === "TASK_RESULT");
    expect(result).toBeTruthy();
    expect(await objectives.applyResult(result!)).toBe("duplicate");

    await runCeoPass(graph, objectives);
    await runCeoPass(graph, objectives);
    const completed = await objectives.get(admin(), objectiveId);
    expect(completed.status).toBe("completed");
    expect(completed.finalOutput).toContain("391");
    expect(provider.requests).toHaveLength(1);
    const tasks = await objectives.tasks(admin(), objectiveId);
    expect(tasks.map((task) => task.departmentSlug)).toEqual(["math"]);
    expect(tasks.map((task) => task.status)).toEqual(["completed"]);

    const events = await objectives.events(admin(), objectiveId, { limit: 50 });
    const eventTypes = events.data.map((event) => event.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining(["objective.submitted", "objective.routed", "objective.completed"]));
    const routedAudit = await expectStatus(
      app,
      {
        method: "GET",
        url: `/api/v1/audit-events?targetId=${objectiveId}&eventType=objective.routed`,
        headers: auth(ADMIN_ID),
      },
      200,
    );
    const completedAudit = await expectStatus(
      app,
      {
        method: "GET",
        url: `/api/v1/audit-events?targetId=${objectiveId}&eventType=objective.completed`,
        headers: auth(ADMIN_ID),
      },
      200,
    );
    expect(routedAudit.data).toHaveLength(1);
    expect(completedAudit.data).toHaveLength(1);

    const breakdownResponse = await app.inject({
      method: "GET",
      url: `/api/v1/objectives/${objectiveId}/performance`,
      headers: auth(ADMIN_ID),
    });
    expect(breakdownResponse.statusCode).toBe(200);
    const breakdown = breakdownResponse.json() as {
      performance: {
        executionPath: string;
        inferenceRequestCount: number;
        planningGpuMs: number | null;
        synthesisGpuMs: number | null;
        specialistGpuMs: number | null;
        inferences: Array<{ purpose: string }>;
        departments: Array<{ departmentSlug: string; taskCount: number; inferenceRequestCount: number; gpuInferenceMs: number | null }>;
      };
    };
    expect(breakdown.performance.executionPath).toBe("direct");
    expect(breakdown.performance.inferenceRequestCount).toBe(1);
    expect(breakdown.performance.inferences.map((row) => row.purpose)).toEqual(["specialist"]);
    expect(breakdown.performance.planningGpuMs).toBeNull();
    expect(breakdown.performance.synthesisGpuMs).toBeNull();
    expect(breakdown.performance.specialistGpuMs).toBe(5);
    expect(breakdown.performance.departments).toEqual([
      expect.objectContaining({ departmentSlug: "math", taskCount: 1, inferenceRequestCount: 1, gpuInferenceMs: 5 }),
    ]);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/objectives/${objectiveId}/performance`,
      headers: auth(MATH_AGENT_PRINCIPAL),
    });
    expect(hidden.statusCode).toBe(403);
    await app.close();
  });

  it("sends a closed argument to reasoning without a CEO inference", async () => {
    await seed(testDb());
    const provider = specialistProvider("The premise contradicts itself.");
    const objectives = service();
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: REASONING } },
      201,
    );
    const objectiveId = created.objective.id as string;
    const graph = compileCeoGraph({ service: objectives, provider, route, workerId: "ceo-test", checkpointer });
    await runCeoPass(graph, objectives);
    expect(provider.requests).toHaveLength(0);
    const orchestration = compileOrchestrationGraph({
      service: objectives,
      route,
      workerId: "orchestration-test",
      checkpointer,
    });
    await runOrchestrationPass(orchestration, randomUUID());
    expect((await deliver(objectives, provider, "specialist")).published).toBe(1);
    await deliver(objectives, provider, "orchestration");
    await runCeoPass(graph, objectives);
    const completed = await objectives.get(admin(), objectiveId);
    expect(completed.status).toBe("completed");
    expect(completed.finalOutput).toContain("contradicts");
    expect(provider.requests).toHaveLength(1);
    expect((await objectives.tasks(admin(), objectiveId)).map((task) => task.departmentSlug)).toEqual(["reasoning"]);
    const breakdown = await objectives.performance(admin(), objectiveId);
    expect(breakdown.executionPath).toBe("direct");
    expect(breakdown.planningGpuMs).toBeNull();
    expect(breakdown.synthesisGpuMs).toBeNull();
    await app.close();
  });

  it("coordinates two specialists without a CEO planning or synthesis inference", async () => {
    await seed(testDb());
    const provider = specialistProvider("Closed specialist answer.");
    const objectives = service();
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: LIGHTWEIGHT } },
      201,
    );
    const objectiveId = created.objective.id as string;
    const graph = compileCeoGraph({ service: objectives, provider, route, workerId: "ceo-test", checkpointer });
    const orchestration = compileOrchestrationGraph({
      service: objectives,
      route,
      workerId: "orchestration-test",
      checkpointer,
    });
    await runCeoPass(graph, objectives);
    expect(provider.requests).toHaveLength(0);
    await runOrchestrationPass(orchestration, randomUUID());
    expect((await deliver(objectives, provider, "specialist")).published).toBe(1);
    await deliver(objectives, provider, "orchestration");
    await runOrchestrationPass(orchestration, randomUUID());
    expect((await deliver(objectives, provider, "specialist")).published).toBe(1);
    await deliver(objectives, provider, "orchestration");
    await runCeoPass(graph, objectives);
    const completed = await objectives.get(admin(), objectiveId);
    expect(completed.status).toBe("completed");
    expect(completed.finalOutput).toContain("math:");
    expect(completed.finalOutput).toContain("reasoning:");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((request) => !request.jsonObject)).toBe(true);
    const breakdown = await objectives.performance(admin(), objectiveId);
    expect(breakdown.executionPath).toBe("lightweight");
    expect(breakdown.inferenceRequestCount).toBe(2);
    expect(breakdown.inferences.every((row) => row.purpose === "specialist")).toBe(true);
    await app.close();
  });

  it("falls back to CEO planning when the objective has no closed specialist", async () => {
    await seed(testDb());
    const provider = new ScriptedInferenceProvider((request) => ({
      text: JSON.stringify(fallbackPlan),
      servedModel: request.modelAlias,
      usage: { inputTokens: 12, outputTokens: 24, source: "observed" },
      latencyMs: 2,
    }));
    const objectives = service();
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: AMBIGUOUS } },
      201,
    );
    const objectiveId = created.objective.id as string;
    const graph = compileCeoGraph({ service: objectives, provider, route, workerId: "ceo-test", checkpointer });
    await runCeoPass(graph, objectives);
    expect(provider.requests.filter((request) => request.jsonObject)).toHaveLength(1);
    expect((await objectives.get(admin(), objectiveId)).status).toBe("scheduled");
    const breakdown = await objectives.performance(admin(), objectiveId);
    expect(breakdown.executionPath).toBe("full");
    expect(breakdown.planningGpuMs).toBe(2);
    expect(breakdown.inferences.map((row) => row.purpose)).toEqual(["plan"]);
    await app.close();
  });

  it("does not execute a direct route before authorization", async () => {
    await seed(testDb());
    const provider = specialistProvider("17 multiplied by 23 is 391.");
    const objectives = service();
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: ARITHMETIC } },
      201,
    );
    const objectiveId = created.objective.id as string;
    const database = createDatabase(TEST_DATABASE_URL);
    try {
      await database.db.execute(sql`update objective_runs set execution_authorized = false where id = ${objectiveId}`);
    } finally {
      await database.close();
    }
    const graph = compileCeoGraph({ service: objectives, provider, route, workerId: "ceo-test", checkpointer });
    await runCeoPass(graph, objectives);
    const waiting = await objectives.get(admin(), objectiveId);
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.executionAuthorized).toBe(false);
    expect(provider.requests).toHaveLength(0);
    const approvedResponse = await app.inject({
      method: "POST",
      url: `/api/v1/objectives/${objectiveId}/approve`,
      headers: auth(ADMIN_ID),
    });
    expect(approvedResponse.statusCode).toBe(200);
    const approved = approvedResponse.json() as { objective: { status: string; executionAuthorized: boolean } };
    expect(approved.objective.status).toBe("scheduled");
    expect(approved.objective.executionAuthorized).toBe(true);
    await app.close();
  });

  it("retries a failed specialist call and completes the direct objective once", async () => {
    await seed(testDb());
    let specialistCalls = 0;
    const provider = new ScriptedInferenceProvider((request) => {
      const system = request.messages.map((message) => message.content).join("\n");
      if (system.includes("JSON object") || system.includes("Synthesize")) {
        throw new Error("CEO inference was not expected");
      }
      specialistCalls += 1;
      if (specialistCalls === 1) {
        throw new InferenceError("unavailable", "specialist down", true);
      }
      return observed(request, "17 multiplied by 23 is 391.");
    });
    const objectives = new ObjectiveService(
      persistence,
      authorizer,
      new MessagingService(persistence, authorizer, { ...DEFAULT_MESSAGING_POLICY, retryBaseMs: 0, retryMaxDelayMs: 0 }),
    );
    const app = await createTestApp();
    const created = await expectStatus(
      app,
      { method: "POST", url: "/api/v1/objectives", headers: auth(ADMIN_ID), payload: { objective: ARITHMETIC } },
      201,
    );
    const objectiveId = created.objective.id as string;
    const graph = compileCeoGraph({ service: objectives, provider, route, workerId: "ceo-test", checkpointer });
    const orchestration = compileOrchestrationGraph({
      service: objectives,
      route,
      workerId: "orchestration-test",
      checkpointer,
    });
    await runCeoPass(graph, objectives);
    await runOrchestrationPass(orchestration, randomUUID());
    expect((await deliver(objectives, provider, "specialist", { ...DEFAULT_MESSAGING_POLICY, retryBaseMs: 0, retryMaxDelayMs: 0 })).published).toBe(1);
    expect((await deliver(objectives, provider, "specialist", { ...DEFAULT_MESSAGING_POLICY, retryBaseMs: 0, retryMaxDelayMs: 0 })).published).toBe(1);
    await deliver(objectives, provider, "orchestration");
    await runCeoPass(graph, objectives);
    await runCeoPass(graph, objectives);
    const completed = await objectives.get(admin(), objectiveId);
    expect(completed.status).toBe("completed");
    expect(completed.finalOutput).toContain("391");
    expect(provider.requests).toHaveLength(2);
    const breakdown = await objectives.performance(admin(), objectiveId);
    expect(breakdown.executionPath).toBe("direct");
    expect(breakdown.inferenceRequestCount).toBe(1);
    expect(breakdown.inferences.map((row) => row.purpose)).toEqual(["specialist"]);
    await app.close();
  });

  function service() {
    return new ObjectiveService(persistence, authorizer, new MessagingService(persistence, authorizer, DEFAULT_MESSAGING_POLICY));
  }
});

function specialistProvider(text: string) {
  return new ScriptedInferenceProvider((request) => {
    const system = request.messages.map((message) => message.content).join("\n");
    if (system.includes("JSON object") || system.includes("Synthesize")) {
      throw new Error("CEO inference was not expected");
    }
    return observed(request, text);
  });
}

function observed(request: InferenceRequest, text: string): InferenceResult {
  return {
    text,
    servedModel: request.modelAlias,
    usage: { inputTokens: 12, outputTokens: 24, source: "observed" },
    latencyMs: 5,
  };
}

async function deliver(
  objectives: ObjectiveService,
  provider: ScriptedInferenceProvider,
  role: "specialist" | "orchestration",
  policy = DEFAULT_MESSAGING_POLICY,
): Promise<{ published: number; bodies: Buffer[] }> {
  const persistence = createPersistence(testDb(), async () => undefined);
  const transport = new ScriptedTransport();
  const messages = new MessagingService(
    persistence,
    new Authorizer(),
    policy,
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
    policy,
  });
  const bodies = transport.published.splice(0, transport.published.length);
  for (const message of bodies) {
    await handleDelivery(messages, `${role}-delivery`, {
      routingKey: message.routingKey,
      body: message.body,
      ack: async () => undefined,
      nack: async () => undefined,
    });
  }
  return { published, bodies: bodies.map((message) => message.body) };
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
