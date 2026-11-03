import { randomUUID } from "node:crypto";
import { QWEN3_4B_MODEL_ID, QWEN3_8B_MODEL_ID, SYSTEM_ADMINISTRATOR_ID, type Message } from "@ai-colony/contracts";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  DomainError,
  MessagingService,
  ObjectiveService,
  type InferenceRoute,
} from "@ai-colony/core";
import { assertDisposableDatabaseUrl, createDatabase, createPersistence, migrateDatabase, schema, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { executePrepared } from "@ai-colony/workflows";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.ROUTING_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const MATH = "00000000-0000-4000-8000-000000000019";
const MATH_AGENT = "00000000-0000-4000-8000-000000000204";
const REASONING = "00000000-0000-4000-8000-00000000001a";
const REASONING_AGENT = "00000000-0000-4000-8000-000000000207";
const route: InferenceRoute = {
  memoryProfile: "shared",
  alias: "qwen3:8b",
  operationalAlias: null,
  temperature: 0,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
  rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
  globalConcurrency: 2,
  departmentConcurrency: 1,
  routingEvidence: {
    state: "installed",
    capturedAt: new Date().toISOString(),
    digest: "sha256:isolated",
    servingTag: "qwen3:8b",
    artifactBytes: 5_200_000_000,
    loadedCount: 0,
  },
};

describe.skipIf(!enabled)("governed routing against isolated PostgreSQL", () => {
  const opened = databaseUrl ? createDatabase(databaseUrl) : null;
  const persistence = opened ? createPersistence(opened.db, opened.close) : null;

  beforeAll(async () => {
    if (!databaseUrl || !opened) {
      return;
    }
    assertDisposableDatabaseUrl(databaseUrl);
    await migrateDatabase(opened.db);
    await migrateDatabase(opened.db);
    await seed(opened.db);
  });

  afterAll(async () => {
    await opened?.close();
  });

  it("pins one model, dispatches that identifier, and keeps the row immutable", async () => {
    if (!opened || !persistence) {
      throw new Error("Isolated database was not opened");
    }
    await opened.db.update(schema.departmentModelAssignments).set({ status: "superseded" }).where(eq(schema.departmentModelAssignments.departmentId, REASONING));
    const service = new ObjectiveService(persistence, new Authorizer(), new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY));
    const runId = randomUUID();
    const taskId = randomUUID();
    await persistence.transaction(async (repos) => {
      await repos.objectives.insertRun({
        id: runId,
        submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
        objective: "Add two and two",
        correlationId: randomUUID(),
        executionAuthorized: true,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: null,
        limits: { maxInferenceRequests: 4, maxOutputTokens: 200, maxEstimatedTokens: 800, maxTaskAttempts: 2, maxConcurrentTasks: 1, maxDurationMs: 60_000 },
      });
      await repos.objectives.saveRun(runId, { status: "running", startedAt: new Date() });
      await repos.objectives.insertTasks([{
        id: taskId,
        objectiveId: runId,
        localId: "math-1",
        departmentId: REASONING,
        departmentSlug: "reasoning",
        taskType: "reasoning",
        objective: "Add two and two",
        expectedOutput: "4",
        dependsOn: [],
      }]);
      await repos.objectives.saveTask(taskId, { status: "dispatched", assignedAgentId: REASONING_AGENT, attempt: 1 });
    });
    const provider = new ScriptedInferenceProvider((request) => ({
      text: "4",
      servedModel: request.modelAlias,
      usage: { inputTokens: 3, outputTokens: 1, source: "observed" },
      latencyMs: 5,
    }));
    const prepared = await service.claimSpecialist(taskMessage(taskId, runId, REASONING), "worker-a", route);
    expect(prepared.action).toBe("generate");
    if (prepared.action !== "generate") {
      return;
    }
    expect(prepared.modelAlias).toBe("qwen3:8b");
    await executePrepared(service, provider, prepared, route);
    expect(provider.requests.map((request) => request.modelAlias)).toEqual(["qwen3:8b"]);
    const pinned = await persistence.repos.routing.findByTask(taskId);
    expect(pinned?.registryModelId).toBe(QWEN3_8B_MODEL_ID);
    expect(pinned?.modelDigest).toBe("sha256:isolated");
    expect(pinned?.fallbackStatus).toBe("disabled");
    const mathAssignments = await opened.db.select().from(schema.departmentModelAssignments).where(eq(schema.departmentModelAssignments.departmentId, REASONING));
    await opened.db.insert(schema.departmentModelAssignments).values({
      id: randomUUID(),
      departmentId: REASONING,
      role: "shared_base",
      registryModelId: QWEN3_4B_MODEL_ID,
      modelFamily: "qwen3",
      version: mathAssignments.length + 1,
      status: "active",
      createdBy: SYSTEM_ADMINISTRATOR_ID,
    });
    const again = await service.claimSpecialist(taskMessage(taskId, runId, REASONING), "worker-a", route);
    expect(again.action).toBe("generate");
    if (again.action === "generate") {
      expect(again.modelAlias).toBe("qwen3:8b");
    }
    await expect(opened.db.update(schema.routingDecisions).set({ servingModel: "changed" }).where(eq(schema.routingDecisions.taskId, taskId))).rejects.toThrow();
    const decisions = await persistence.repos.audit.list({ limit: 20, cursor: null, eventType: "routing.decision" });
    const executions = await persistence.repos.audit.list({ limit: 20, cursor: null, eventType: "routing.execution" });
    expect(decisions.data.length).toBeGreaterThan(0);
    expect(executions.data.some((event) => event.action === "completed")).toBe(true);
  });

  it("rejects a forged department before inference", async () => {
    if (!persistence) {
      throw new Error("Isolated database was not opened");
    }
    const service = new ObjectiveService(persistence, new Authorizer(), new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY));
    const runId = randomUUID();
    const taskId = randomUUID();
    await persistence.transaction(async (repos) => {
      await repos.objectives.insertRun({
        id: runId,
        submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
        objective: "Reject a forged department",
        correlationId: randomUUID(),
        executionAuthorized: true,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: null,
        limits: { maxInferenceRequests: 4, maxOutputTokens: 200, maxEstimatedTokens: 800, maxTaskAttempts: 2, maxConcurrentTasks: 1, maxDurationMs: 60_000 },
      });
      await repos.objectives.saveRun(runId, { status: "running", startedAt: new Date() });
      await repos.objectives.insertTasks([{
        id: taskId,
        objectiveId: runId,
        localId: "math-2",
        departmentId: MATH,
        departmentSlug: "math",
        taskType: "math",
        objective: "Stay in math",
        expectedOutput: "ok",
        dependsOn: [],
      }]);
      await repos.objectives.saveTask(taskId, { status: "dispatched", assignedAgentId: MATH_AGENT, attempt: 1 });
    });
    const provider = new ScriptedInferenceProvider((request) => ({ text: "no", servedModel: request.modelAlias, usage: { inputTokens: 1, outputTokens: 1, source: "observed" }, latencyMs: 1 }));
    await expect(service.claimSpecialist(taskMessage(taskId, runId, "00000000-0000-4000-8000-0000000000aa"), "worker-b", route)).rejects.toBeInstanceOf(DomainError);
    expect(provider.requests).toHaveLength(0);
  });

  it("selects a deployment-authorized specialized model and denies an inactive department", async () => {
    if (!opened || !persistence) {
      throw new Error("Isolated database was not opened");
    }
    const science = "00000000-0000-4000-8000-00000000001b";
    await opened.db.update(schema.models).set({ status: "available" }).where(eq(schema.models.id, QWEN3_4B_MODEL_ID));
    await opened.db.update(schema.departments).set({ status: "active" }).where(eq(schema.departments.id, science));
    const scienceAssignments = await opened.db.select().from(schema.departmentModelAssignments).where(eq(schema.departmentModelAssignments.departmentId, science));
    if (scienceAssignments.length === 0) {
      await opened.db.insert(schema.departmentModelAssignments).values({
        id: randomUUID(),
        departmentId: science,
        role: "shared_base",
        registryModelId: QWEN3_4B_MODEL_ID,
        modelFamily: "qwen3",
        version: 1,
        status: "active",
        createdBy: SYSTEM_ADMINISTRATOR_ID,
      });
    }
    const service = new ObjectiveService(persistence, new Authorizer(), new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY));
    const runId = randomUUID();
    const taskId = randomUUID();
    await persistence.transaction(async (repos) => {
      await repos.objectives.insertRun({
        id: runId,
        submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
        objective: "Use the specialized assignment",
        correlationId: randomUUID(),
        executionAuthorized: true,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: null,
        limits: { maxInferenceRequests: 4, maxOutputTokens: 200, maxEstimatedTokens: 800, maxTaskAttempts: 2, maxConcurrentTasks: 1, maxDurationMs: 60_000 },
      });
      await repos.objectives.saveRun(runId, { status: "running", startedAt: new Date() });
      await repos.objectives.insertTasks([{
        id: taskId,
        objectiveId: runId,
        localId: "science-1",
        departmentId: science,
        departmentSlug: "science",
        taskType: "science",
        objective: "Use the assigned model",
        expectedOutput: "ok",
        dependsOn: [],
      }]);
      await repos.objectives.saveTask(taskId, { status: "dispatched", assignedAgentId: "00000000-0000-4000-8000-000000000205", attempt: 1 });
    });
    const specializedRoute: InferenceRoute = {
      ...route,
      routingEvidence: { ...route.routingEvidence!, servingTag: "qwen3:4b", digest: "sha256:qwen4" },
    };
    const prepared = await service.claimSpecialist(taskMessage(taskId, runId, science), "worker-c", specializedRoute);
    expect(prepared.action).toBe("generate");
    if (prepared.action === "generate") {
      expect(prepared.modelAlias).toBe("qwen3:4b");
      expect(prepared.registryModelId).toBe(QWEN3_4B_MODEL_ID);
    }
    await opened.db.update(schema.departments).set({ status: "paused" }).where(eq(schema.departments.id, science));
    const deniedRun = randomUUID();
    const deniedTask = randomUUID();
    await persistence.transaction(async (repos) => {
      await repos.objectives.insertRun({
        id: deniedRun,
        submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
        objective: "Denied department",
        correlationId: randomUUID(),
        executionAuthorized: true,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: null,
        limits: { maxInferenceRequests: 4, maxOutputTokens: 200, maxEstimatedTokens: 800, maxTaskAttempts: 2, maxConcurrentTasks: 1, maxDurationMs: 60_000 },
      });
      await repos.objectives.saveRun(deniedRun, { status: "running", startedAt: new Date() });
      await repos.objectives.insertTasks([{
        id: deniedTask,
        objectiveId: deniedRun,
        localId: "science-2",
        departmentId: science,
        departmentSlug: "science",
        taskType: "science",
        objective: "Should be denied",
        expectedOutput: "none",
        dependsOn: [],
      }]);
      await repos.objectives.saveTask(deniedTask, { status: "dispatched", assignedAgentId: "00000000-0000-4000-8000-000000000205", attempt: 1 });
    });
    const provider = new ScriptedInferenceProvider((request) => ({ text: "no", servedModel: request.modelAlias, usage: { inputTokens: 1, outputTokens: 1, source: "observed" }, latencyMs: 1 }));
    const denied = await service.claimSpecialist(taskMessage(deniedTask, deniedRun, science), "worker-d", specializedRoute);
    expect(denied.action).toBe("done");
    expect(provider.requests).toHaveLength(0);
    const decision = await persistence.repos.routing.findByTask(deniedTask);
    expect(decision?.reasonCode).toBe("department_inactive");
  });

  it("stores one decision when two workers claim the same task", async () => {
    if (!opened || !persistence) {
      throw new Error("Isolated database was not opened");
    }
    await opened.db.update(schema.departmentModelAssignments).set({ status: "superseded" }).where(eq(schema.departmentModelAssignments.departmentId, "00000000-0000-4000-8000-000000000018"));
    const service = new ObjectiveService(persistence, new Authorizer(), new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY));
    const runId = randomUUID();
    const taskId = randomUUID();
    await persistence.transaction(async (repos) => {
      await repos.objectives.insertRun({
        id: runId,
        submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
        objective: "Concurrent claim",
        correlationId: randomUUID(),
        executionAuthorized: true,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: null,
        limits: { maxInferenceRequests: 4, maxOutputTokens: 200, maxEstimatedTokens: 800, maxTaskAttempts: 2, maxConcurrentTasks: 1, maxDurationMs: 60_000 },
      });
      await repos.objectives.saveRun(runId, { status: "running", startedAt: new Date() });
      await repos.objectives.insertTasks([{
        id: taskId,
        objectiveId: runId,
        localId: "research-1",
        departmentId: "00000000-0000-4000-8000-000000000018",
        departmentSlug: "research",
        taskType: "research",
        objective: "One decision",
        expectedOutput: "one",
        dependsOn: [],
      }]);
      await repos.objectives.saveTask(taskId, { status: "dispatched", assignedAgentId: "00000000-0000-4000-8000-000000000206", attempt: 1 });
    });
    const [first, second] = await Promise.all([
      service.claimSpecialist(taskMessage(taskId, runId, "00000000-0000-4000-8000-000000000018"), "worker-1", route),
      service.claimSpecialist(taskMessage(taskId, runId, "00000000-0000-4000-8000-000000000018"), "worker-2", route),
    ]);
    const actions = [first.action, second.action].sort();
    expect(actions).toContain("generate");
    const rows = await persistence.repos.routing.findByTask(taskId);
    expect(rows?.registryModelId).toBe(QWEN3_8B_MODEL_ID);
  });

  it("dispatches a verified derived serving model for an approved adapter", async () => {
    if (!opened || !persistence) {
      throw new Error("Isolated database was not opened");
    }
    const departmentId = "00000000-0000-4000-8000-000000000018";
    const existing = await opened.db.select().from(schema.departmentModelAssignments).where(eq(schema.departmentModelAssignments.departmentId, departmentId));
    await opened.db.insert(schema.departmentModelAssignments).values({
      id: randomUUID(),
      departmentId,
      role: "capability_adapter",
      registryModelId: QWEN3_8B_MODEL_ID,
      adapterSha256: "adapter-sha",
      modelFamily: "qwen3",
      version: existing.length + 1,
      status: "active",
      createdBy: SYSTEM_ADMINISTRATOR_ID,
    });
    const service = new ObjectiveService(persistence, new Authorizer(), new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY));
    const runId = randomUUID();
    const taskId = randomUUID();
    await persistence.transaction(async (repos) => {
      await repos.objectives.insertRun({
        id: runId,
        submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
        objective: "Use the derived adapter",
        correlationId: randomUUID(),
        executionAuthorized: true,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: null,
        limits: { maxInferenceRequests: 4, maxOutputTokens: 200, maxEstimatedTokens: 800, maxTaskAttempts: 2, maxConcurrentTasks: 1, maxDurationMs: 60_000 },
      });
      await repos.objectives.saveRun(runId, { status: "running", startedAt: new Date() });
      await repos.objectives.insertTasks([{
        id: taskId,
        objectiveId: runId,
        localId: "research-adapter",
        departmentId,
        departmentSlug: "research",
        taskType: "research",
        objective: "Use the derived adapter",
        expectedOutput: "ok",
        dependsOn: [],
      }]);
      await repos.objectives.saveTask(taskId, { status: "dispatched", assignedAgentId: "00000000-0000-4000-8000-000000000206", attempt: 1 });
    });
    const provider = new ScriptedInferenceProvider((request) => ({ text: "ok", servedModel: request.modelAlias, usage: { inputTokens: 1, outputTokens: 1, source: "observed" }, latencyMs: 1 }));
    const prepared = await service.claimSpecialist(taskMessage(taskId, runId, departmentId), "worker-e", {
      ...route,
      derivedServing: {
        servingModel: "research-adapter:v3",
        digest: "sha256:derived",
        baseRegistryModelId: QWEN3_8B_MODEL_ID,
        adapterId: "adapter-sha",
        adapterVersion: "3",
        provenanceVerified: true,
      },
    });
    expect(prepared.action).toBe("generate");
    if (prepared.action !== "generate") {
      return;
    }
    expect(prepared.modelAlias).toBe("research-adapter:v3");
    await executePrepared(service, provider, prepared, route);
    expect(provider.requests.map((request) => request.modelAlias)).toEqual(["research-adapter:v3"]);
  });
});

function taskMessage(taskId: string, objectiveId: string, departmentId: string): Message {
  return {
    messageType: "TASK_REQUEST",
    payload: { taskId, objective: "work", expectedOutput: "answer", context: "" },
    metadata: { kind: "objective-task", objectiveId, attempt: 1, departmentId },
    recipientAgentId: null,
  } as unknown as Message;
}
