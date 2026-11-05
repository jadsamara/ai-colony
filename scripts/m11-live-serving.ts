import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { freemem, totalmem } from "node:os";
import { QWEN3_8B_MODEL_ID, SYSTEM_ADMINISTRATOR_ID, type Message } from "../packages/contracts/dist/index.js";
import { Authorizer, DEFAULT_MESSAGING_POLICY, MessagingService, ObjectiveService, assessLiveServing, type InferenceRoute } from "../packages/core/dist/index.js";
import { assertDisposableDatabaseUrl, createDatabase, createPersistence, migrateDatabase, seed } from "../packages/database/dist/index.js";
import { OllamaStatusClient, OpenAICompatibleProvider } from "../packages/inference/dist/index.js";
import { executePrepared } from "../packages/workflows/dist/index.js";

const databaseUrl = process.env.LIVE_SERVING_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("LIVE_SERVING_DATABASE_URL is required and must not be inherited from DATABASE_URL");
}
const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
  throw new Error("Refusing a non-local live-serving database");
}
if (parsed.port !== "5435" || databaseName === "ai_colony" || databaseUrl.includes("/tmp/ai-colony-pg")) {
  throw new Error("Refusing canonical PostgreSQL for the live serving smoke test");
}
assertDisposableDatabaseUrl(databaseUrl);

const REASONING = "00000000-0000-4000-8000-00000000001a";
const REASONING_AGENT = "00000000-0000-4000-8000-000000000207";
const baseUrl = process.env.INFERENCE_BASE_URL ?? "http://127.0.0.1:11434";
const alias = "qwen3:8b";
const startedAt = Date.now();

function memorySample(label: string) {
  let processes: string[] = [];
  try {
    processes = execFileSync("ps", ["-axo", "rss=,comm="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("ollama"));
  } catch {
    processes = [];
  }
  return {
    label,
    freeBytes: freemem(),
    totalBytes: totalmem(),
    ollamaRss: processes,
  };
}

const status = new OllamaStatusClient({ baseUrl, timeoutMs: 5_000, minIntervalMs: 0 });
const before = await status.inspect();
const beforeMemory = memorySample("before");
const assessed = assessLiveServing({
  requestedAlias: alias,
  reachable: before.reachable,
  stale: before.stale,
  checkedAt: before.checkedAt,
  installed: before.installed,
  loaded: before.loaded,
});
const route: InferenceRoute = {
  memoryProfile: "shared",
  alias,
  operationalAlias: null,
  temperature: 0,
  maxOutputTokens: 32,
  timeoutMs: 180_000,
  rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
  globalConcurrency: 1,
  departmentConcurrency: 1,
  routingEvidence: assessed.evidence,
  routingResourceAllowed: assessed.resourceAllowed,
  routingMemoryKnown: assessed.memoryKnown,
  routingResourceDetail: assessed.resourceDetail,
};

const opened = createDatabase(databaseUrl);
const persistence = createPersistence(opened.db, opened.close);
const report: Record<string, unknown> = {
  category: "governed_end_to_end_inference",
  canonicalExecution: "not_demonstrated",
  databasePort: parsed.port,
  databaseName,
  departmentId: REASONING,
  departmentSlug: "reasoning",
  modelAlias: alias,
  registryModelId: QWEN3_8B_MODEL_ID,
  ollamaBefore: {
    reachable: before.reachable,
    version: before.version,
    installed: before.installed,
    loaded: before.loaded,
  },
  assessment: assessed,
  memoryBefore: beforeMemory,
};

try {
  await migrateDatabase(opened.db);
  await seed(opened.db);
  const runId = randomUUID();
  const taskId = randomUUID();
  report.objectiveId = runId;
  report.taskId = taskId;
  await persistence.transaction(async (repos) => {
    await repos.objectives.insertRun({
      id: runId,
      submitterPrincipalId: SYSTEM_ADMINISTRATOR_ID,
      objective: "M11 diagnostic: reply with the single word four.",
      correlationId: randomUUID(),
      executionAuthorized: true,
      memoryProfile: "shared",
      primaryModelId: QWEN3_8B_MODEL_ID,
      operationalModelId: null,
      limits: { maxInferenceRequests: 2, maxOutputTokens: 64, maxEstimatedTokens: 2_000, maxTaskAttempts: 1, maxConcurrentTasks: 1, maxDurationMs: 180_000 },
    });
    await repos.objectives.saveRun(runId, { status: "running", startedAt: new Date() });
    await repos.objectives.insertTasks([{
      id: taskId,
      objectiveId: runId,
      localId: "m11-four",
      departmentId: REASONING,
      departmentSlug: "reasoning",
      taskType: "reasoning",
      objective: "Reply with the single word four.",
      expectedOutput: "four",
      dependsOn: [],
    }]);
    await repos.objectives.saveTask(taskId, { status: "dispatched", assignedAgentId: REASONING_AGENT, attempt: 1 });
  });
  const service = new ObjectiveService(persistence, new Authorizer(), new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY));
  const prepared = await service.claimSpecialist({
    messageType: "TASK_REQUEST",
    payload: { taskId, objective: "Reply with the single word four.", expectedOutput: "four", context: "" },
    metadata: { kind: "objective-task", objectiveId: runId, attempt: 1, departmentId: REASONING },
    recipientAgentId: null,
  } as unknown as Message, "m11-live-serving", route);
  report.preparedAction = prepared.action;
  if (prepared.action !== "generate") {
    report.outcome = "routing_denied_before_generation";
    const decision = await persistence.repos.routing.findByTask(taskId);
    report.routingDecision = decision;
  } else {
    report.preparedAlias = prepared.modelAlias;
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey: null,
      maxConcurrency: 1,
      transportRetries: 0,
    });
    const inferenceStarted = Date.now();
    try {
      const text = await executePrepared(service, provider, prepared, route);
      report.outcome = "completed";
      report.text = text;
      report.inferenceMs = Date.now() - inferenceStarted;
    } catch (error) {
      report.outcome = "execution_failed";
      report.error = error instanceof Error ? error.message : "inference failed";
      report.inferenceMs = Date.now() - inferenceStarted;
    }
    report.routingDecision = await persistence.repos.routing.findByTask(taskId);
    const usage = await persistence.repos.objectives.getInferenceById(prepared.requestId);
    report.inferenceStatus = usage?.status ?? null;
    const executions = await persistence.repos.audit.list({ limit: 10, cursor: null, eventType: "routing.execution" });
    report.executionAudit = executions.data.filter((event) => event.targetId === prepared.requestId).map((event) => ({
      action: event.action,
      metadata: event.metadata,
    }));
  }
  const after = await status.inspect();
  report.ollamaAfter = { loaded: after.loaded, installedDigest: after.installed.find((model) => model.name === alias) ?? null };
  report.memoryAfter = memorySample("after");
  report.elapsedMs = Date.now() - startedAt;
  report.liveInference = report.outcome === "completed" ? "governed_qwen3_8b" : "attempted";
  report.specializedModelExecuted = false;
  report.adapterModelExecuted = false;
  report.directOllamaGenerate = false;
} finally {
  await opened.close();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.outcome !== "completed") {
  process.exitCode = 1;
}
