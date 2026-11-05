import { randomUUID } from "node:crypto";
import {
  OBJECTIVE_HARD_CAPS,
  QWEN3_4B_MODEL_ID,
  QWEN3_8B_MODEL_ID,
  objectiveLimitsSchema,
  objectivePlanSchema,
  objectiveSchema,
  objectiveTaskSchema,
  type Message,
  type ObjectiveCreate,
  type ObjectiveLimits,
  type ObjectiveRecord,
  type ObjectiveStatus,
  type ObjectiveTask,
  type RuntimeStatus,
} from "@ai-colony/contracts";
import { snapshot, type RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { ROLE_PERMISSIONS } from "../governance/permissions.js";
import type { ChatMessage } from "../inference/provider.js";
import {
  estimateCostUsdMicros,
  estimateTokens,
  type CostRates,
  type TokenUsage,
} from "../inference/usage.js";
import type { MessagingService } from "../messaging/message-service.js";
import { decodeCursor } from "../pagination.js";
import type {
  EligibleAgent,
  ObjectiveRun,
  ObjectiveTaskRecord,
  Persistence,
} from "../ports/repositories.js";
import { extractJsonObject, validatePlan } from "./plan.js";
import { planPrompt, RESEARCH_EVIDENCE_FOOTER, specialistPrompt, synthesisPrompt, withMemory } from "./prompts.js";
import { blockedTaskIds, chooseDispatch, readyTaskIds } from "./schedule.js";
import { evaluateRouting } from "../routing/evaluate.js";
import type { RoutingSelection, RoutingSnapshot, RuntimeEvidence } from "../routing/types.js";
import { CEO_DEPARTMENT_ID, LEGACY_ROUTING_POLICY_VERSION } from "../routing/policy.js";
import { gateDedicatedExecution, type DedicatedRoutingConfig } from "../serving/activation.js";
import { assertObjectiveTransition, assertTaskTransition, isTerminalObjective, isTerminalTask } from "./transitions.js";

export const DEFAULT_OBJECTIVE_LIMITS: ObjectiveLimits = {
  maxInferenceRequests: 12,
  maxOutputTokens: 8192,
  maxEstimatedTokens: 32_000,
  maxTaskAttempts: 2,
  maxConcurrentTasks: 1,
  maxDurationMs: 30 * 60 * 1000,
};

export interface InferenceRoute {
  memoryProfile: "shared" | "split";
  alias: string;
  operationalAlias: string | null;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  rates: CostRates;
  globalConcurrency: number;
  departmentConcurrency: number;
  routingEvidence?: RuntimeEvidence;
  routingResourceAllowed?: boolean;
  routingMemoryKnown?: boolean;
  routingResourceDetail?: string | null;
  derivedServing?: RoutingSnapshot["derived"];
  dedicatedRouting?: DedicatedRoutingConfig;
}

export type PreparedGeneration =
  | { action: "wait" | "done" }
  | {
      action: "generate";
      requestId: string;
      purpose: "plan" | "correct" | "synthesize" | "specialist";
      objectiveId: string;
      taskId: string | null;
      attempt: number;
      reservedOutputTokens: number;
      messages: ReturnType<typeof planPrompt>;
      registryModelId: string;
      intendedModelId: string;
      modelAlias: string;
      temperature: number;
      maxOutputTokens: number;
      timeoutMs: number;
      cachedText: string | null;
      servingInstanceId: string | null;
    };

const WORKER_ACTOR = "system:workflow";
const SPECIALIST_SLUGS = ["math", "science", "research", "reasoning"] as const;

export interface ObjectiveMemory {
  contextFor(input: { purpose: string; objectiveId: string; taskId: string | null; query: string }): Promise<string>;
  capture(input: { purpose: string; objectiveId: string; taskId: string | null; text: string }): Promise<void>;
}

export class ObjectiveService {
  private memory: ObjectiveMemory | null = null;

  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly messages: MessagingService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  attachMemory(memory: ObjectiveMemory | null): void {
    this.memory = memory;
  }

  async memoryMessages(prepared: PreparedGeneration): Promise<ChatMessage[] | null> {
    if (!this.memory || prepared.action !== "generate" || prepared.cachedText || prepared.messages.length === 0) {
      return null;
    }
    try {
      const context = await this.memory.contextFor({
        purpose: prepared.purpose,
        objectiveId: prepared.objectiveId,
        taskId: prepared.taskId,
        query: prepared.messages.map((message) => message.content).join("\n").slice(0, 2000),
      });
      return context.trim() ? withMemory(prepared.messages, context) : null;
    } catch {
      return null;
    }
  }

  async submit(ctx: RequestContext, input: ObjectiveCreate): Promise<ObjectiveRecord> {
    this.authorizer.assert(ctx.actor, "objective:submit");
    const limits = objectiveLimitsSchema.parse({ ...DEFAULT_OBJECTIVE_LIMITS, ...input.limits });
    const authorized = ROLE_PERMISSIONS[ctx.actor.role].has("objective:execute");
    const created = await this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.insertRun({
        id: randomUUID(),
        submitterPrincipalId: ctx.actor.principalId,
        objective: input.objective,
        correlationId: randomUUID(),
        executionAuthorized: authorized,
        memoryProfile: "shared",
        primaryModelId: QWEN3_8B_MODEL_ID,
        operationalModelId: QWEN3_4B_MODEL_ID,
        limits,
      });
      await repos.objectives.appendEvent({
        id: randomUUID(),
        objectiveId: run.id,
        eventType: "objective.submitted",
        summary: "Objective submitted",
      });
      await repos.audit.append({
        eventType: "objective.submitted",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "objective",
        targetId: run.id,
        action: "objective.submitted",
        correlationId: ctx.correlationId,
        beforeState: null,
        afterState: snapshot(publicRun(run)),
        metadata: { executionAuthorized: authorized },
      });
      return run;
    });
    return publicRun(created);
  }

  async get(ctx: RequestContext, id: string): Promise<ObjectiveRecord> {
    const run = await this.requireVisible(ctx, id);
    return publicRun(run);
  }

  async list(ctx: RequestContext, query: { limit: number; cursor?: string; status?: ObjectiveStatus }) {
    this.authorizer.assertAny(ctx.actor, ["objective:read", "objective:admin"]);
    const admin = ROLE_PERMISSIONS[ctx.actor.role].has("objective:admin");
    return this.persistence.repos.objectives.listRuns({
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
      status: query.status,
      submitterPrincipalId: admin ? undefined : ctx.actor.principalId,
    }).then((page) => ({ ...page, data: page.data.map(publicRun) }));
  }

  async tasks(ctx: RequestContext, id: string): Promise<ObjectiveTask[]> {
    await this.requireVisible(ctx, id);
    const tasks = await this.persistence.repos.objectives.listTasks(id);
    return tasks.map(publicTask);
  }

  async events(ctx: RequestContext, id: string, query: { limit: number; cursor?: string }) {
    await this.requireVisible(ctx, id);
    return this.persistence.repos.objectives.listEvents({
      objectiveId: id,
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
    });
  }

  async cancel(ctx: RequestContext, id: string): Promise<ObjectiveRecord> {
    this.authorizer.assert(ctx.actor, "objective:cancel");
    return this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.lockRun(id);
      if (!run) {
        throw notFound("Objective", id);
      }
      if (
        run.submitterPrincipalId !== ctx.actor.principalId &&
        !ROLE_PERMISSIONS[ctx.actor.role].has("objective:admin")
      ) {
        throw notFound("Objective", id);
      }
      if (isTerminalObjective(run.status)) {
        return publicRun(run);
      }
      assertObjectiveTransition(run.status, "cancelled");
      const updated = await repos.objectives.saveRun(id, {
        status: "cancelled",
        completedAt: this.now(),
        failureReason: "cancelled",
      });
      await this.stopTasks(repos, id, "cancelled");
      await this.event(repos, id, "objective.cancelled", "Objective cancelled");
      await repos.audit.append({
        eventType: "objective.cancelled",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "objective",
        targetId: id,
        action: "objective.cancelled",
        correlationId: ctx.correlationId,
        beforeState: snapshot(publicRun(run)),
        afterState: snapshot(publicRun(updated)),
        metadata: {},
      });
      return publicRun(updated);
    });
  }

  async approve(ctx: RequestContext, id: string): Promise<ObjectiveRecord> {
    this.authorizer.assert(ctx.actor, "objective:execute");
    return this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.lockRun(id);
      if (!run) {
        throw notFound("Objective", id);
      }
      if (run.status !== "awaiting_approval") {
        throw new DomainError("INVALID_TRANSITION", "Objective is not awaiting approval", 409);
      }
      assertObjectiveTransition(run.status, "scheduled");
      const updated = await repos.objectives.saveRun(id, {
        status: "scheduled",
        executionAuthorized: true,
        startedAt: run.startedAt ? new Date(run.startedAt) : this.now(),
      });
      await this.event(repos, id, "objective.approved", "Execution authorized");
      await repos.audit.append({
        eventType: "objective.approved",
        actorId: ctx.actor.principalId,
        actorType: ctx.actor.principalType,
        targetType: "objective",
        targetId: id,
        action: "objective.approved",
        correlationId: ctx.correlationId,
        beforeState: snapshot(publicRun(run)),
        afterState: snapshot(publicRun(updated)),
        metadata: {},
      });
      return publicRun(updated);
    });
  }

  async prepareCeo(objectiveId: string, route: InferenceRoute, workerId: string): Promise<PreparedGeneration> {
    const expired = await this.expireObjective(objectiveId);
    if (expired) {
      return { action: "done" };
    }
    return this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.lockRun(objectiveId);
      if (!run) {
        throw notFound("Objective", objectiveId);
      }
      if (isTerminalObjective(run.status) || run.status === "awaiting_approval") {
        return { action: run.status === "awaiting_approval" ? "wait" : "done" };
      }
      const tasks = await repos.objectives.listTasks(objectiveId);
      if (run.status === "running" || run.status === "scheduled") {
        if (tasks.length === 0 || tasks.some((task) => !isTerminalTask(task.status))) {
          return { action: "wait" };
        }
        if (tasks.some((task) => task.status !== "completed")) {
          await this.fail(repos, run, "A specialist task failed");
          return { action: "done" };
        }
        if (run.status === "scheduled") {
          assertObjectiveTransition("scheduled", "running");
          await repos.objectives.saveRun(run.id, { status: "running", startedAt: this.now() });
        }
        assertObjectiveTransition("running", "synthesizing");
        await repos.objectives.saveRun(run.id, { status: "synthesizing" });
        return this.prepareTextCall(repos, { ...run, status: "synthesizing" }, "synthesize", route, workerId, null);
      }
      if (run.status === "synthesizing") {
        return this.prepareTextCall(repos, run, "synthesize", route, workerId, null);
      }
      if (run.status === "submitted") {
        assertObjectiveTransition("submitted", "planning");
        await repos.objectives.saveRun(run.id, { status: "planning", startedAt: this.now() });
      }
      const latest = await repos.objectives.latestPlan(objectiveId);
      if (latest?.valid) {
        await this.materialize(repos, { ...run, status: "planning" }, objectivePlanSchema.parse(latest.body));
        return { action: "wait" };
      }
      const purpose = run.planCorrections > 0 ? "correct" : "plan";
      return this.prepareTextCall(
        repos,
        { ...run, status: "planning" },
        purpose,
        route,
        workerId,
        null,
      );
    });
  }

  async completeGeneration(input: {
    requestId: string;
    text: string;
    servedModel: string;
    usage: TokenUsage;
    latencyMs: number;
    route: InferenceRoute;
  }): Promise<"accepted" | "invalid" | "completed" | "failed"> {
    const stored = await this.persistence.repos.objectives.getInferenceById(input.requestId);
    if (!stored) {
      throw notFound("InferenceRequest", input.requestId);
    }
    if (stored.status === "completed" && stored.responseText) {
      return stored.purpose === "synthesize" ? "completed" : "accepted";
    }
    const cost = estimateCostUsdMicros(input.usage, input.route.rates);
    const estimatedOut = input.usage.outputTokens === null ? estimateTokens(input.text) : 0;
    const estimatedIn = input.usage.inputTokens === null ? estimateTokens(input.text) : 0;
    await this.persistence.transaction(async (repos) => {
      await repos.objectives.finishInference(stored.id, {
        status: "completed",
        responseText: input.text,
        error: null,
      });
      await repos.objectives.insertUsage({
        requestId: stored.id,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        tokenSource: input.usage.source,
        servedModel: input.servedModel,
        latencyMs: input.latencyMs,
        estimatedCostUsdMicros: cost,
        overrideApplied: stored.intendedModelId !== stored.registryModelId,
      });
      await repos.objectives.reconcile({
        objectiveId: stored.objectiveId,
        reservedOutputTokens: stored.reservedOutputTokens,
        observedInputTokens: input.usage.inputTokens ?? 0,
        observedOutputTokens: input.usage.outputTokens ?? 0,
        estimatedInputTokens: estimatedIn,
        estimatedOutputTokens: estimatedOut,
        estimatedCostUsdMicros: cost,
      });
      const run = await repos.objectives.getRun(stored.objectiveId);
      const decision = stored.taskId
        ? await repos.routing.findByTask(stored.taskId)
        : await repos.routing.findByObjectivePurpose(stored.objectiveId, stored.purpose);
      await repos.audit.append({
        eventType: "routing.execution",
        actorId: WORKER_ACTOR,
        actorType: "system",
        targetType: "inference_request",
        targetId: stored.id,
        action: "completed",
        correlationId: run?.correlationId ?? stored.objectiveId,
        beforeState: null,
        afterState: null,
        metadata: {
          objectiveId: stored.objectiveId,
          taskId: stored.taskId,
          registryModelId: stored.registryModelId,
          requestedAlias: stored.requestedAlias,
          servedModel: input.servedModel,
          latencyMs: input.latencyMs,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          decisionId: decision?.id ?? null,
          modelDigest: decision?.modelDigest ?? null,
          executionVerification: decision?.executionVerification ?? "unverified",
          resourceOutcome: decision?.resourceOutcome ?? null,
          assignmentVersion: decision?.assignmentVersion ?? null,
          adapterId: decision?.adapterId ?? null,
        },
      });
    });
    if (stored.purpose === "synthesize") {
      await this.finishSynthesis(stored.objectiveId, input.text);
      await this.remember(stored, input.text);
      return "completed";
    }
    if (stored.purpose === "plan" || stored.purpose === "correct") {
      const outcome = await this.acceptPlan(stored.objectiveId, input.text);
      if (outcome === "accepted") {
        await this.remember(stored, input.text);
      }
      return outcome;
    }
    await this.remember(stored, input.text);
    return "accepted";
  }

  private async remember(
    stored: { purpose: string; objectiveId: string; taskId: string | null },
    text: string,
  ): Promise<void> {
    if (!this.memory) {
      return;
    }
    try {
      await this.memory.capture({
        purpose: stored.purpose,
        objectiveId: stored.objectiveId,
        taskId: stored.taskId,
        text,
      });
    } catch {
      // Memory capture must not fail an objective that already finished its model call.
    }
  }

  async failGeneration(requestId: string, error: string): Promise<void> {
    const stored = await this.persistence.repos.objectives.getInferenceById(requestId);
    if (!stored || stored.status === "completed") {
      return;
    }
    await this.persistence.transaction(async (repos) => {
      await repos.objectives.finishInference(stored.id, {
        status: "failed",
        responseText: null,
        error: error.slice(0, 500),
      });
      await repos.objectives.releaseReservation(stored.objectiveId, stored.reservedOutputTokens);
      const run = await repos.objectives.getRun(stored.objectiveId);
      await repos.audit.append({
        eventType: "routing.execution",
        actorId: WORKER_ACTOR,
        actorType: "system",
        targetType: "inference_request",
        targetId: stored.id,
        action: "failed",
        correlationId: run?.correlationId ?? stored.objectiveId,
        beforeState: null,
        afterState: null,
        metadata: { objectiveId: stored.objectiveId, error: error.slice(0, 120) },
      });
    });
  }

  async schedule(route: InferenceRoute, workerId: string): Promise<number> {
    const runs = await this.persistence.repos.objectives.listRuns({ limit: 100, cursor: null });
    for (const run of runs.data) {
      await this.expireObjective(run.id);
    }
    const tasks = await this.persistence.repos.objectives.listTasks();
    await this.persistence.transaction(async (repos) => {
      for (const taskId of blockedTaskIds(tasks)) {
        const task = await repos.objectives.lockTask(taskId);
        if (task && (task.status === "pending" || task.status === "ready")) {
          assertTaskTransition(task.status, "failed");
          await repos.objectives.saveTask(task.id, {
            status: "failed",
            error: "A dependency failed",
            completedAt: this.now(),
          });
        }
      }
      for (const task of tasks) {
        if ((task.status === "dispatched" || task.status === "running") && task.deadline && Date.parse(task.deadline) <= this.now().getTime()) {
          await this.timeoutTask(repos, task);
        }
      }
    });
    const refreshed = await this.persistence.repos.objectives.listTasks();
    await this.persistence.transaction(async (repos) => {
      for (const taskId of readyTaskIds(refreshed)) {
        const task = await repos.objectives.lockTask(taskId);
        if (task?.status === "pending") {
          assertTaskTransition("pending", "ready");
          await repos.objectives.saveTask(task.id, { status: "ready" });
        }
      }
      const scheduled = new Set(
        (await repos.objectives.listRuns({ limit: 100, cursor: null, status: "scheduled" })).data.map((run) => run.id),
      );
      for (const objectiveId of scheduled) {
        const run = await repos.objectives.lockRun(objectiveId);
        if (run?.status === "scheduled") {
          assertObjectiveTransition("scheduled", "running");
          await repos.objectives.saveRun(objectiveId, { status: "running", startedAt: run.startedAt ? new Date(run.startedAt) : this.now() });
        }
      }
    });
    const current = await this.persistence.repos.objectives.listTasks();
    const inflight = current.filter((task) => task.status === "dispatched" || task.status === "running");
    const selected = chooseDispatch(current, {
      globalInflight: inflight.length,
      globalLimit: route.globalConcurrency,
      perObjective: OBJECTIVE_HARD_CAPS.maxTasks,
      perDepartment: route.departmentConcurrency,
      inflightByObjective: countBy(inflight, (task) => task.objectiveId),
      inflightByDepartment: countBy(inflight, (task) => task.departmentId),
    });
    const launched = new Map<string, number>();
    let dispatched = 0;
    for (const taskId of selected) {
      const task = current.find((item) => item.id === taskId);
      if (!task) {
        continue;
      }
      const run = await this.persistence.repos.objectives.getRun(task.objectiveId);
      const used = (countBy(inflight, (item) => item.objectiveId)[task.objectiveId] ?? 0) + (launched.get(task.objectiveId) ?? 0);
      if (!run || used >= run.limits.maxConcurrentTasks || used >= route.globalConcurrency) {
        continue;
      }
      const did = await this.dispatch(task, workerId);
      if (did) {
        launched.set(task.objectiveId, (launched.get(task.objectiveId) ?? 0) + 1);
        dispatched += 1;
      }
    }
    return dispatched;
  }

  async claimSpecialist(message: Message, workerId: string, route: InferenceRoute): Promise<PreparedGeneration> {
    if (message.messageType !== "TASK_REQUEST" || message.metadata.kind !== "objective-task") {
      return { action: "wait" };
    }
    const taskId = message.payload.taskId;
    const expired = await this.expireObjective(String(message.metadata.objectiveId ?? ""));
    if (expired) {
      return { action: "done" };
    }
    return this.persistence.transaction(async (repos) => {
      const task = await repos.objectives.lockTask(taskId);
      if (!task) {
        return { action: "done" };
      }
      const run = await repos.objectives.lockRun(task.objectiveId);
      if (!run || isTerminalObjective(run.status) || isTerminalTask(task.status)) {
        return { action: "done" };
      }
      if (task.assignedAgentId && message.recipientAgentId && task.assignedAgentId !== message.recipientAgentId) {
        throw new DomainError("AUTHORIZATION_DENIED", "Task is addressed to a different agent", 403);
      }
      if (message.metadata.objectiveId && message.metadata.objectiveId !== task.objectiveId) {
        throw new DomainError("AUTHORIZATION_DENIED", "Message objective does not match the persisted task", 403);
      }
      const claimedDepartment = message.metadata.departmentId ?? ("departmentId" in message.payload ? message.payload.departmentId : undefined);
      if (typeof claimedDepartment === "string" && claimedDepartment !== task.departmentId) {
        throw new DomainError("AUTHORIZATION_DENIED", "Message department does not match the persisted task", 403);
      }
      const leaseFresh = task.leaseUntil !== null && Date.parse(task.leaseUntil) > this.now().getTime();
      if (task.status === "running" && leaseFresh && task.leaseOwner !== workerId) {
        return { action: "wait" };
      }
      if (task.status === "dispatched") {
        assertTaskTransition(task.status, "running");
        await repos.objectives.saveTask(task.id, {
          status: "running",
          leaseOwner: workerId,
          leaseUntil: new Date(this.now().getTime() + route.timeoutMs),
          startedAt: this.now(),
        });
      } else if (task.status === "running") {
        await repos.objectives.saveTask(task.id, {
          leaseOwner: workerId,
          leaseUntil: new Date(this.now().getTime() + route.timeoutMs),
        });
      }
      return this.prepareTextCall(repos, run, "specialist", route, workerId, task);
    });
  }

  async applyResult(message: Message): Promise<"applied" | "duplicate"> {
    if (message.messageType !== "TASK_RESULT" || message.metadata.kind !== "objective-result") {
      return "duplicate";
    }
    const taskId = message.payload.taskId;
    const attempt = Number(message.metadata.attempt ?? 0);
    return this.persistence.transaction(async (repos) => {
      const task = await repos.objectives.lockTask(taskId);
      if (!task) {
        return "duplicate";
      }
      if (task.assignedAgentId && message.senderAgentId !== task.assignedAgentId) {
        throw new DomainError("AUTHORIZATION_DENIED", "Result is not from the assigned agent", 403);
      }
      const existing = await repos.objectives.findResult(task.id, attempt);
      if (existing || task.status === "completed") {
        return "duplicate";
      }
      if (task.status !== "running" && task.status !== "dispatched") {
        return "duplicate";
      }
      const failed = message.payload.status !== "recorded";
      const summary = task.taskType === "research" && !message.payload.summary.includes(RESEARCH_EVIDENCE_FOOTER)
        ? `${message.payload.summary}\n\n${RESEARCH_EVIDENCE_FOOTER}`
        : message.payload.summary;
      await repos.objectives.insertResult({
        id: randomUUID(),
        taskId: task.id,
        attempt,
        status: message.payload.status,
        summary,
        messageId: message.messageId,
      });
      assertTaskTransition(task.status, failed ? "failed" : "completed");
      await repos.objectives.saveTask(task.id, {
        status: failed ? "failed" : "completed",
        resultSummary: summary,
        error: failed ? summary : null,
        leaseOwner: null,
        leaseUntil: null,
        completedAt: this.now(),
      });
      await this.event(repos, task.objectiveId, failed ? "task.failed" : "task.completed", task.localId);
      return "applied";
    });
  }

  async publishSpecialistResult(message: Message, text: string): Promise<void> {
    if (message.messageType !== "TASK_REQUEST") {
      return;
    }
    const taskId = message.payload.taskId;
    const task = (await this.persistence.repos.objectives.listTasks()).find((item) => item.id === taskId);
    if (!task || !task.assignedAgentId) {
      return;
    }
    const attempt = task.attempt;
    if (await this.persistence.repos.objectives.findResult(task.id, attempt)) {
      return;
    }
    const agent = await this.persistence.repos.objectives.findAgent(task.assignedAgentId);
    const orchestration = await this.requireDepartmentAgent("orchestration");
    if (!agent) {
      return;
    }
    const run = await this.persistence.repos.objectives.getRun(task.objectiveId);
    if (!run) {
      return;
    }
    const summary = clip(task.taskType === "research" ? `${text}\n\n${RESEARCH_EVIDENCE_FOOTER}` : text, 4000);
    await this.messages.send(agentContext(agent, run.correlationId), {
      messageType: "TASK_RESULT",
      priority: 5,
      recipientAgentId: orchestration.id,
      correlationId: run.correlationId,
      causationId: message.messageId,
      replyToMessageId: message.messageId,
      idempotencyKey: `taskres:${task.id}:${attempt}`,
      payload: { taskId: task.id, status: "recorded", summary, artifactReferences: [] },
      metadata: { kind: "objective-result", objectiveId: task.objectiveId, attempt },
    });
  }

  // The stored runtime status is the last explicit /v1/models probe. Live health does not write it.
  async recordProbe(input: {
    modelId: string;
    endpointUrl: string;
    expectedAlias: string;
    reachable: boolean;
    modelIds: string[];
    error: string | null;
  }): Promise<RuntimeStatus> {
    const matched = input.reachable && input.modelIds.includes(input.expectedAlias);
    const runtimeStatus: RuntimeStatus = !input.reachable ? "unavailable" : matched ? "ready" : "failed";
    await this.persistence.repos.objectives.upsertRuntime({
      modelId: input.modelId,
      runtimeStatus,
      endpointUrl: input.endpointUrl,
      expectedAlias: input.expectedAlias,
      loadedModelId: matched ? input.expectedAlias : null,
      lastError: matched ? null : (input.error ?? "Loaded model identity did not match the configured alias"),
      probedAt: this.now(),
    });
    return runtimeStatus;
  }

  async health(ctx: RequestContext, route: Pick<InferenceRoute, "memoryProfile" | "globalConcurrency">) {
    this.authorizer.assert(ctx.actor, "inference:read");
    return {
      models: await this.persistence.repos.objectives.listRuntimes(),
      memoryProfile: route.memoryProfile,
      concurrency: route.globalConcurrency,
    };
  }

  async latestCompletedInferenceAt(ctx: RequestContext): Promise<string | null> {
    this.authorizer.assertAny(ctx.actor, ["inference:read", "monitoring:read"]);
    const value = await this.persistence.repos.objectives.latestCompletedInferenceAt();
    return value ? value.toISOString() : null;
  }

  async runtimeEvidence(ctx: RequestContext) {
    this.authorizer.assertAny(ctx.actor, ["inference:read", "monitoring:read"]);
    const [models, heartbeats, metrics, latest] = await Promise.all([
      this.persistence.repos.objectives.listRuntimes(),
      this.persistence.repos.objectives.listHeartbeats(),
      this.persistence.repos.messages.metrics(),
      this.persistence.repos.objectives.latestCompletedInferenceAt(),
    ]);
    return {
      models,
      heartbeats,
      metrics,
      latestCompletedInferenceAt: latest ? latest.toISOString() : null,
    };
  }

  async overview(ctx: RequestContext, staleAfterMs: number) {
    this.authorizer.assert(ctx.actor, "monitoring:read");
    const counts = await this.persistence.repos.objectives.counts();
    const metrics = await this.persistence.repos.messages.metrics();
    const heartbeats = await this.persistence.repos.objectives.listHeartbeats();
    const models = await this.persistence.repos.objectives.listRuntimes();
    const tasks = await this.persistence.repos.objectives.listTasks();
    const findings = monitoringFindings({
      models,
      heartbeats,
      tasks,
      deadLetters: metrics.deadLettersOpen,
      now: this.now().getTime(),
      staleAfterMs,
    });
    const objectiveCounts = zeroCounts([
      "submitted",
      "planning",
      "awaiting_approval",
      "scheduled",
      "running",
      "synthesizing",
      "completed",
      "failed",
      "cancelled",
    ]);
    for (const row of counts.objectives) {
      objectiveCounts[row.status] = row.count;
    }
    const taskCounts = zeroCounts(["pending", "ready", "dispatched", "running", "completed", "failed", "timed_out", "cancelled"]);
    for (const row of counts.tasks) {
      taskCounts[row.status] = row.count;
    }
    return {
      objectives: objectiveCounts,
      tasks: taskCounts,
      outboxPending: metrics.outbox.pending,
      deadLettersOpen: metrics.deadLettersOpen,
      workers: heartbeats.map((beat) => ({
        workerId: beat.workerId,
        role: beat.role,
        beatAt: beat.beatAt,
        stale: this.now().getTime() - Date.parse(beat.beatAt) > staleAfterMs,
      })),
      models,
      inference: {
        requests: counts.inferenceRequests,
        observedOutputTokens: counts.observedOutputTokens,
        estimatedOutputTokens: counts.estimatedOutputTokens,
        unavailableUsage: counts.unavailableUsage,
        estimatedCostUsdMicros: counts.estimatedCostUsdMicros,
      },
      training: await this.persistence.repos.training.summary(),
      safeguards: await this.persistence.repos.evaluation.summary(),
      findings,
    };
  }

  async activeIds(): Promise<string[]> {
    const page = await this.persistence.repos.objectives.listRuns({ limit: 100, cursor: null });
    return page.data
      .filter((run) =>
        run.status === "submitted" ||
        run.status === "planning" ||
        run.status === "running" ||
        run.status === "synthesizing",
      )
      .map((run) => run.id);
  }

  async heartbeat(workerId: string, role: string, detail: string | null): Promise<void> {
    await this.persistence.repos.objectives.heartbeat({
      workerId,
      role,
      beatAt: this.now(),
      detail,
    });
  }

  async specialistDepartments(onlySlug?: string | null): Promise<string[]> {
    const ids: string[] = [];
    const slugs = onlySlug ? [onlySlug] : SPECIALIST_SLUGS;
    for (const slug of slugs) {
      const department = await this.persistence.repos.objectives.findDepartmentBySlug(slug);
      if (department?.status === "active") {
        ids.push(department.id);
      }
    }
    return ids;
  }

  async orchestrationDepartment(): Promise<string | null> {
    const department = await this.persistence.repos.objectives.findDepartmentBySlug("orchestration");
    return department?.status === "active" ? department.id : null;
  }

  async alert(finding: { code: string; severity: "info" | "warning" | "critical"; summary: string }, objectiveId: string | null): Promise<boolean> {
    const eventType = `health.${finding.code}`;
    if (await this.persistence.repos.objectives.hasEvent(objectiveId, eventType)) {
      return false;
    }
    const agent = await this.requireDepartmentAgent("monitoring");
    const target = objectiveId
      ? await this.requireDepartmentAgent("orchestration")
      : await this.requireDepartmentAgent("ceo");
    await this.messages.send(agentContext(agent, randomUUID()), {
      messageType: "HEALTH_ALERT",
      priority: 7,
      recipientAgentId: target.id,
      idempotencyKey: `health:${finding.code}:${objectiveId ?? "colony"}`.slice(0, 128),
      payload: {
        severity: finding.severity,
        component: finding.code,
        summary: clip(finding.summary, 4000),
        observedAt: this.now().toISOString(),
      },
      metadata: { kind: "health-alert", objectiveId },
    });
    await this.persistence.repos.objectives.appendEvent({
      id: randomUUID(),
      objectiveId,
      eventType,
      summary: finding.summary,
    });
    return true;
  }

  private async acceptPlan(objectiveId: string, text: string): Promise<"accepted" | "invalid" | "failed"> {
    return this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.lockRun(objectiveId);
      if (!run || run.status !== "planning") {
        return "accepted";
      }
      const context = await this.planContext(repos, run.limits.maxInferenceRequests, run.limits.maxOutputTokens);
      let body: unknown;
      try {
        body = extractJsonObject(text);
      } catch (error) {
        body = { invalid: error instanceof Error ? error.message : "invalid json" };
      }
      const validated = validatePlan(body, context);
      const version = (await repos.objectives.latestPlan(objectiveId))?.version ?? 0;
      await repos.objectives.insertPlan({
        id: randomUUID(),
        objectiveId,
        version: version + 1,
        body: validated.plan ? { ...validated.plan } : { raw: text.slice(0, 2000) },
        valid: Boolean(validated.plan),
        errors: validated.errors,
      });
      if (!validated.plan) {
        const next = run.planCorrections + 1;
        if (next > OBJECTIVE_HARD_CAPS.maxPlanCorrections) {
          await this.fail(repos, run, validated.errors.join("; ") || "Plan remained invalid");
          return "failed";
        }
        await repos.objectives.saveRun(objectiveId, { planCorrections: next });
        await this.event(repos, objectiveId, "plan.rejected", validated.errors.join("; ") || "invalid plan");
        return "invalid";
      }
      await this.materialize(repos, run, validated.plan);
      return "accepted";
    });
  }

  private async finishSynthesis(objectiveId: string, text: string): Promise<void> {
    await this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.lockRun(objectiveId);
      if (!run || run.status === "completed") {
        return;
      }
      if (run.status !== "synthesizing") {
        return;
      }
      assertObjectiveTransition("synthesizing", "completed");
      const updated = await repos.objectives.saveRun(objectiveId, {
        status: "completed",
        finalOutput: text,
        completedAt: this.now(),
      });
      await this.event(repos, objectiveId, "objective.completed", "Final answer stored");
      await repos.audit.append({
        eventType: "objective.completed",
        actorId: WORKER_ACTOR,
        actorType: "system",
        targetType: "objective",
        targetId: objectiveId,
        action: "objective.completed",
        correlationId: run.correlationId,
        beforeState: snapshot(publicRun(run)),
        afterState: snapshot(publicRun(updated)),
        metadata: {},
      });
    });
  }

  private async prepareTextCall(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    run: ObjectiveRun,
    purpose: "plan" | "correct" | "synthesize" | "specialist",
    route: InferenceRoute,
    workerId: string,
    task: ObjectiveTaskRecord | null,
  ): Promise<PreparedGeneration> {
    const attempt = purpose === "specialist" ? (task?.attempt ?? 1) : run.planCorrections + 1;
    const key = purpose === "specialist" && task ? `specialist:${task.id}:${attempt}` : `${purpose}:${run.id}:${attempt}`;
    const existing = await repos.objectives.getInference(key);
    if (existing?.status === "completed" && existing.responseText) {
      return {
        action: "generate",
        requestId: existing.id,
        purpose,
        objectiveId: run.id,
        taskId: task?.id ?? null,
        attempt,
        reservedOutputTokens: existing.reservedOutputTokens,
        messages: [],
        registryModelId: existing.registryModelId,
        intendedModelId: existing.intendedModelId,
        modelAlias: existing.requestedAlias,
        temperature: route.temperature,
        maxOutputTokens: route.maxOutputTokens,
        timeoutMs: route.timeoutMs,
        cachedText: existing.responseText,
        servingInstanceId: null,
      };
    }
    if (
      existing?.status === "running" &&
      existing.leaseUntil &&
      Date.parse(existing.leaseUntil) > this.now().getTime() &&
      existing.leaseOwner !== workerId
    ) {
      return { action: "wait" };
    }
    if (existing?.status === "failed") {
      const reservedOk = await repos.objectives.reserve({
        objectiveId: run.id,
        outputTokens: existing.reservedOutputTokens,
        estimatedTokens: existing.reservedOutputTokens,
      });
      if (!reservedOk) {
        await this.fail(repos, run, "Objective inference budget is exhausted");
        return { action: "done" };
      }
      await repos.objectives.reopenInference(
        existing.id,
        workerId,
        new Date(this.now().getTime() + route.timeoutMs),
      );
    }
    const decision = existing
      ? null
      : await this.ensureRoutingDecision(repos, run, purpose, route, task);
    if (decision && decision.authorization !== "authorized") {
      await this.fail(repos, run, decision.reasonCode);
      return { action: "done" };
    }
    const dedicated = await this.pinDedicatedServing(repos, run, purpose, route, task, decision);
    if (!dedicated.ok) {
      await this.fail(repos, run, dedicated.reason);
      return { action: "done" };
    }
    const choice = decision
      ? { registryModelId: decision.registryModelId, intendedModelId: decision.registryModelId, alias: decision.servingModel }
      : { registryModelId: existing?.registryModelId ?? QWEN3_8B_MODEL_ID, intendedModelId: existing?.intendedModelId ?? QWEN3_8B_MODEL_ID, alias: existing?.requestedAlias ?? route.alias };
    const reserved = route.maxOutputTokens;
    const prompt = await this.messagesFor(repos, run, purpose, task);
    const estimated = estimateTokens(prompt.map((item) => item.content).join("\n")) + reserved;
    if (!existing) {
      const reservedOk = await repos.objectives.reserve({
        objectiveId: run.id,
        outputTokens: reserved,
        estimatedTokens: estimated,
      });
      if (!reservedOk) {
        await this.fail(repos, run, "Objective inference budget is exhausted");
        return { action: "done" };
      }
      const id = randomUUID();
      const created = await repos.objectives.insertInference({
        id,
        objectiveId: run.id,
        taskId: task?.id ?? null,
        attempt,
        purpose,
        registryModelId: choice.registryModelId,
        intendedModelId: choice.intendedModelId,
        requestedAlias: choice.alias,
        reservedOutputTokens: reserved,
        idempotencyKey: key,
        leaseOwner: workerId,
        leaseUntil: new Date(this.now().getTime() + route.timeoutMs),
      });
      if (created === "exists") {
        await repos.objectives.releaseReservation(run.id, reserved);
        return { action: "wait" };
      }
      return {
        action: "generate",
        requestId: id,
        purpose,
        objectiveId: run.id,
        taskId: task?.id ?? null,
        attempt,
        reservedOutputTokens: reserved,
        messages: prompt,
        registryModelId: choice.registryModelId,
        intendedModelId: choice.intendedModelId,
        modelAlias: choice.alias,
        temperature: route.temperature,
        maxOutputTokens: route.maxOutputTokens,
        timeoutMs: route.timeoutMs,
        cachedText: null,
        servingInstanceId: dedicated.instanceId,
      };
    }
    return {
      action: "generate",
      requestId: existing.id,
      purpose,
      objectiveId: run.id,
      taskId: task?.id ?? null,
      attempt,
      reservedOutputTokens: existing.reservedOutputTokens,
      messages: prompt,
      registryModelId: existing.registryModelId,
      intendedModelId: existing.intendedModelId,
      modelAlias: existing.requestedAlias,
      temperature: route.temperature,
      maxOutputTokens: route.maxOutputTokens,
      timeoutMs: route.timeoutMs,
      cachedText: null,
      servingInstanceId: dedicated.instanceId,
    };
  }

  private async pinDedicatedServing(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    run: ObjectiveRun,
    purpose: "plan" | "correct" | "synthesize" | "specialist",
    route: InferenceRoute,
    task: ObjectiveTaskRecord | null,
    decision: RoutingSelection | null,
  ): Promise<{ ok: true; instanceId: string | null } | { ok: false; reason: string }> {
    if (!route.dedicatedRouting?.enabled) {
      return { ok: true, instanceId: null };
    }
    const stored = decision
      ? null
      : task
        ? await repos.routing.findByTask(task.id)
        : await repos.routing.findByObjectivePurpose(run.id, purpose);
    const selection = decision ?? (stored ? selectionFromStored(stored) : null);
    const evidence = stored?.runtimeEvidence.dedicatedModelVersion;
    const pinnedModelVersion = typeof evidence === "string"
      ? evidence
      : route.dedicatedRouting.instances.find((instance) => instance.instanceId === selection?.servingInstanceId)?.modelVersion ?? null;
    const gate = gateDedicatedExecution(selection, route.dedicatedRouting.instances, pinnedModelVersion);
    return gate.ok ? { ok: true, instanceId: gate.instanceId } : gate;
  }

  private async messagesFor(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    run: ObjectiveRun,
    purpose: "plan" | "correct" | "synthesize" | "specialist",
    task: ObjectiveTaskRecord | null,
  ) {
    if (purpose === "specialist" && task) {
      return specialistPrompt(publicTask(task));
    }
    if (purpose === "synthesize") {
      const tasks = await repos.objectives.listTasks(run.id);
      const plan = await repos.objectives.latestPlan(run.id);
      const parsed = objectivePlanSchema.parse(plan?.body ?? { summary: run.objective, tasks: [], completionCriteria: ["complete"], estimatedResources: { inferenceRequests: 1, outputTokens: 1 }, risks: ["none"] });
      return synthesisPrompt(
        run.objective,
        parsed,
        tasks.map((item) => ({ department: item.departmentSlug, summary: item.resultSummary ?? "" })),
      );
    }
    const latest = await repos.objectives.latestPlan(run.id);
    return planPrompt(run.objective, latest && !latest.valid ? latest.errors : [], {
      maxInferenceRequests: run.limits.maxInferenceRequests,
      maxOutputTokens: run.limits.maxOutputTokens,
    });
  }

  private async materialize(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    run: ObjectiveRun,
    plan: NonNullable<ReturnType<typeof validatePlan>["plan"]>,
  ) {
    const existing = await repos.objectives.listTasks(run.id);
    if (existing.length === 0) {
      const ids = new Map(plan.tasks.map((task) => [task.localId, randomUUID()]));
      const rows = [];
      for (const task of plan.tasks) {
        const department = await repos.objectives.findDepartmentBySlug(task.departmentSlug);
        if (!department) {
          throw new DomainError("INVALID_REFERENCE", `Department ${task.departmentSlug} was not found`, 422);
        }
        rows.push({
          id: ids.get(task.localId) ?? randomUUID(),
          objectiveId: run.id,
          localId: task.localId,
          departmentId: department.id,
          departmentSlug: task.taskType,
          taskType: task.taskType,
          objective: task.objective,
          expectedOutput: task.expectedOutput,
          dependsOn: task.dependsOn.map((dependency) => ids.get(dependency) ?? dependency),
        });
      }
      await repos.objectives.insertTasks(rows);
    }
    const next = run.executionAuthorized ? "scheduled" : "awaiting_approval";
    assertObjectiveTransition(run.status, next);
    await repos.objectives.saveRun(run.id, { status: next });
    await this.event(repos, run.id, "plan.accepted", plan.summary);
  }

  private async dispatch(task: ObjectiveTaskRecord, _workerId: string): Promise<boolean> {
    const run = await this.persistence.repos.objectives.getRun(task.objectiveId);
    if (!run || run.status !== "running") {
      return false;
    }
    const agents = await this.persistence.repos.objectives.listEligibleAgents(task.departmentId);
    const assignee = agents[0];
    const orchestration = await this.requireDepartmentAgent("orchestration");
    if (!assignee) {
      await this.persistence.transaction(async (repos) => {
        const locked = await repos.objectives.lockTask(task.id);
        if (locked?.status === "ready") {
          assertTaskTransition("ready", "failed");
          await repos.objectives.saveTask(task.id, { status: "failed", error: "No eligible agent", completedAt: this.now() });
        }
      });
      return false;
    }
    const deadline = new Date(this.now().getTime() + Math.min(run.limits.maxDurationMs, 10 * 60 * 1000));
    const sent = await this.messages.send(agentContext(orchestration, run.correlationId), {
      messageType: "TASK_REQUEST",
      priority: 5,
      recipientAgentId: assignee.id,
      correlationId: run.correlationId,
      idempotencyKey: `taskreq:${task.id}:${task.attempt}`,
      expiresAt: deadline.toISOString(),
      payload: {
        taskId: task.id,
        objective: task.objective,
        constraints: task.taskType === "research"
          ? ["No external research tools are configured. Do not invent citations."]
          : ["Do not request tools or permissions."],
        expectedOutput: task.expectedOutput,
        deadline: deadline.toISOString(),
        contextReferences: [`objective:${run.id}`],
      },
      metadata: { kind: "objective-task", objectiveId: run.id, attempt: task.attempt },
    });
    await this.persistence.transaction(async (repos) => {
      const locked = await repos.objectives.lockTask(task.id);
      if (!locked || locked.status !== "ready") {
        return;
      }
      assertTaskTransition("ready", "dispatched");
      await repos.objectives.saveTask(task.id, {
        status: "dispatched",
        assignedAgentId: assignee.id,
        requestMessageId: sent.message.messageId,
        deadline,
      });
      await repos.objectives.insertAssignment({
        id: randomUUID(),
        taskId: task.id,
        agentId: assignee.id,
        departmentId: task.departmentId,
        attempt: task.attempt,
      });
      await this.event(repos, task.objectiveId, "task.dispatched", task.localId);
    });
    return true;
  }

  private async timeoutTask(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    task: ObjectiveTaskRecord,
  ) {
    const run = await repos.objectives.getRun(task.objectiveId);
    if (!run) {
      return;
    }
    assertTaskTransition(task.status, "timed_out");
    if (task.attempt < run.limits.maxTaskAttempts) {
      await repos.objectives.saveTask(task.id, { status: "timed_out", leaseOwner: null, leaseUntil: null });
      assertTaskTransition("timed_out", "ready");
      await repos.objectives.saveTask(task.id, {
        status: "ready",
        attempt: task.attempt + 1,
        deadline: null,
        error: "Timed out",
      });
      return;
    }
    await repos.objectives.saveTask(task.id, {
      status: "failed",
      error: "Timed out",
      completedAt: this.now(),
      leaseOwner: null,
      leaseUntil: null,
    });
  }

  private async expireObjective(objectiveId: string): Promise<boolean> {
    return this.persistence.transaction(async (repos) => {
      const run = await repos.objectives.lockRun(objectiveId);
      if (!run || !run.startedAt || isTerminalObjective(run.status)) {
        return false;
      }
      if (this.now().getTime() - Date.parse(run.startedAt) <= run.limits.maxDurationMs) {
        return false;
      }
      await this.fail(repos, run, "Objective exceeded its duration limit");
      return true;
    });
  }

  private async ensureRoutingDecision(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    run: ObjectiveRun,
    purpose: "plan" | "correct" | "synthesize" | "specialist",
    route: InferenceRoute,
    task: ObjectiveTaskRecord | null,
  ): Promise<RoutingSelection> {
    const stored = task
      ? await repos.routing.findByTask(task.id)
      : await repos.routing.findByObjectivePurpose(run.id, purpose);
    if (stored) {
      return selectionFromStored(stored);
    }
    const departmentId = task?.departmentId ?? CEO_DEPARTMENT_ID;
    const department = await repos.departments.findById(departmentId);
    const agent = task?.assignedAgentId ? await repos.objectives.findAgent(task.assignedAgentId) : null;
    const assignments = await repos.learning.listAssignments(departmentId);
    const modelIds = new Set<string>([QWEN3_8B_MODEL_ID, ...assignments.map((row) => row.registryModelId)]);
    const models: Record<string, RoutingSnapshot["models"][string]> = {};
    for (const modelId of modelIds) {
      const model = await repos.models.findById(modelId);
      if (model) {
        models[model.id] = { id: model.id, status: model.status, modelFamily: model.modelFamily, displayName: model.displayName };
      }
    }
    let certifiedCapabilityCount = 0;
    let syntheticCapabilityCount = 0;
    try {
      const snapshots = await repos.capability.listSnapshots({ departmentId });
      for (const snapshot of snapshots) {
        if (snapshot.evidenceRef.startsWith("synthetic:") || snapshot.provenance.toLowerCase().includes("synthetic")) {
          syntheticCapabilityCount += 1;
        } else {
          certifiedCapabilityCount += 1;
        }
      }
    } catch {
      certifiedCapabilityCount = 0;
      syntheticCapabilityCount = 0;
    }
    const evidence = route.routingEvidence ?? {
      state: "readiness_unknown" as const,
      capturedAt: null,
      digest: null,
      servingTag: null,
      artifactBytes: null,
      loadedCount: null,
    };
    const selection = evaluateRouting({
      departmentId,
      departmentStatus: department?.status ?? "inactive",
      agentDepartmentId: agent?.departmentId ?? null,
      assignments,
      models,
      requestedModelId: null,
      sharedServingTag: route.alias,
      derived: route.derivedServing ?? null,
      evidence,
      now: this.now().toISOString(),
      budgetAllowed: run.consumedRequests + run.reservedRequests < run.limits.maxInferenceRequests,
      resourceAllowed: route.routingResourceAllowed !== false,
      memoryKnown: route.routingMemoryKnown === true,
      servingBackend: "ollama",
      dedicated: route.dedicatedRouting?.enabled
        ? {
            instances: route.dedicatedRouting.instances,
            requestedEndpoint: null,
            requestedInstanceId: null,
            pinnedInstanceId: null,
            pinnedModelVersion: null,
          }
        : undefined,
      certifiedCapabilityCount,
      syntheticCapabilityCount,
      executionDigest: null,
    });
    const row = {
      id: randomUUID(),
      taskId: task?.id ?? null,
      objectiveId: run.id,
      purpose,
      departmentId,
      assignmentId: selection.assignmentId,
      assignmentVersion: selection.assignmentVersion,
      registryModelId: selection.registryModelId,
      servingModel: selection.servingModel,
      modelDigest: selection.modelDigest,
      adapterId: selection.adapterId,
      adapterVersion: selection.adapterVersion,
      policyVersion: selection.policyVersion,
      authorization: selection.authorization,
      reasonCode: selection.reasonCode,
      budgetOutcome: selection.budgetOutcome,
      resourceOutcome: selection.resourceOutcome,
      fallbackStatus: "disabled" as const,
      executionVerification: selection.executionVerification,
      capabilityNote: selection.capabilityNote,
      servingInstanceId: selection.servingInstanceId,
      endpointReference: selection.endpointReference,
      agentId: selection.agentId,
      servingPolicyVersion: selection.servingPolicyVersion,
      runtimeEvidence: {
        state: evidence.state,
        capturedAt: evidence.capturedAt,
        digest: evidence.digest,
        servingTag: evidence.servingTag,
        artifactBytes: evidence.artifactBytes,
        loadedCount: evidence.loadedCount,
        policyVersion: LEGACY_ROUTING_POLICY_VERSION,
        resourceDetail: route.routingResourceDetail ?? null,
        dedicatedModelVersion: selection.servingInstanceId
          ? route.dedicatedRouting?.instances.find((instance) => instance.instanceId === selection.servingInstanceId)?.modelVersion ?? null
          : null,
      },
      createdAt: this.now().toISOString(),
    };
    try {
      await repos.routing.insert(row);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "CONFLICT") {
        throw error;
      }
      const winner = task
        ? await repos.routing.findByTask(task.id)
        : await repos.routing.findByObjectivePurpose(run.id, purpose);
      if (!winner) {
        throw error;
      }
      return selectionFromStored(winner);
    }
    await repos.audit.append({
      eventType: "routing.decision",
      actorId: WORKER_ACTOR,
      actorType: "system",
      targetType: task ? "objective_task" : "objective",
      targetId: task?.id ?? run.id,
      action: selection.authorization,
      correlationId: run.correlationId,
      beforeState: null,
      afterState: null,
      metadata: {
        decisionId: row.id,
        departmentId,
        assignmentId: selection.assignmentId,
        assignmentVersion: selection.assignmentVersion,
        registryModelId: selection.registryModelId,
        servingModel: selection.servingModel,
        modelDigest: selection.modelDigest,
        adapterId: selection.adapterId,
        reasonCode: selection.reasonCode,
        policyVersion: selection.policyVersion,
        fallbackStatus: "disabled",
      },
    });
    return selection;
  }

  private async fail(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    run: ObjectiveRun,
    reason: string,
  ) {
    if (isTerminalObjective(run.status)) {
      return;
    }
    assertObjectiveTransition(run.status, "failed");
    const updated = await repos.objectives.saveRun(run.id, {
      status: "failed",
      failureReason: reason.slice(0, 500),
      completedAt: this.now(),
    });
    await this.stopTasks(repos, run.id, "cancelled");
    await this.event(repos, run.id, "objective.failed", reason);
    await repos.audit.append({
      eventType: "objective.failed",
      actorId: WORKER_ACTOR,
      actorType: "system",
      targetType: "objective",
      targetId: run.id,
      action: "objective.failed",
      correlationId: run.correlationId,
      beforeState: snapshot(publicRun(run)),
      afterState: snapshot(publicRun(updated)),
      metadata: { reason },
    });
  }

  private async stopTasks(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    objectiveId: string,
    status: "cancelled",
  ) {
    const tasks = await repos.objectives.listTasks(objectiveId);
    for (const task of tasks) {
      if (!isTerminalTask(task.status) && task.status !== "timed_out") {
        assertTaskTransition(task.status, status);
        await repos.objectives.saveTask(task.id, { status, completedAt: this.now(), leaseOwner: null, leaseUntil: null });
      }
    }
  }

  private async planContext(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    maxInferenceRequests: number,
    maxOutputTokens: number,
  ) {
    const active = new Set<string>();
    const staffed = new Set<string>();
    for (const slug of SPECIALIST_SLUGS) {
      const department = await repos.objectives.findDepartmentBySlug(slug);
      if (department?.status === "active") {
        active.add(slug);
        const agents = await repos.objectives.listEligibleAgents(department.id);
        if (agents.length > 0) {
          staffed.add(slug);
        }
      }
    }
    return { activeDepartmentSlugs: active, staffedDepartmentSlugs: staffed, maxInferenceRequests, maxOutputTokens };
  }

  private async requireVisible(ctx: RequestContext, id: string): Promise<ObjectiveRun> {
    this.authorizer.assertAny(ctx.actor, ["objective:read", "objective:admin"]);
    const run = await this.persistence.repos.objectives.getRun(id);
    const admin = ROLE_PERMISSIONS[ctx.actor.role].has("objective:admin");
    if (!run || (!admin && run.submitterPrincipalId !== ctx.actor.principalId)) {
      throw notFound("Objective", id);
    }
    return run;
  }

  private async requireDepartmentAgent(slug: string): Promise<EligibleAgent> {
    const department = await this.persistence.repos.objectives.findDepartmentBySlug(slug);
    if (!department) {
      throw notFound("Department", slug);
    }
    const agents = await this.persistence.repos.objectives.listEligibleAgents(department.id);
    const agent = agents[0];
    if (!agent) {
      throw new DomainError("CONFLICT", `No eligible agent is available in ${slug}`, 409);
    }
    return agent;
  }

  private async event(
    repos: Parameters<Parameters<Persistence["transaction"]>[0]>[0],
    objectiveId: string,
    eventType: string,
    summary: string,
  ) {
    await repos.objectives.appendEvent({ id: randomUUID(), objectiveId, eventType, summary: clip(summary, 500) });
  }

}

function publicRun(run: ObjectiveRun): ObjectiveRecord {
  return objectiveSchema.parse({
    id: run.id,
    submitterPrincipalId: run.submitterPrincipalId,
    objective: run.objective,
    status: run.status,
    correlationId: run.correlationId,
    failureReason: run.failureReason,
    finalOutput: run.finalOutput,
    executionAuthorized: run.executionAuthorized,
    planCorrections: run.planCorrections,
    limits: run.limits,
    consumedRequests: run.consumedRequests,
    consumedOutputTokens: run.consumedOutputTokens,
    estimatedOutputTokens: run.estimatedOutputTokens,
    estimatedCostUsdMicros: run.estimatedCostUsdMicros,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
  });
}

function publicTask(task: ObjectiveTaskRecord): ObjectiveTask {
  return objectiveTaskSchema.parse({
    id: task.id,
    objectiveId: task.objectiveId,
    localId: task.localId,
    departmentId: task.departmentId,
    departmentSlug: task.departmentSlug,
    taskType: task.taskType,
    objective: task.objective,
    expectedOutput: task.expectedOutput,
    dependsOn: task.dependsOn,
    status: task.status,
    attempt: task.attempt,
    assignedAgentId: task.assignedAgentId,
    requestMessageId: task.requestMessageId,
    error: task.error,
    resultSummary: task.resultSummary,
    deadline: task.deadline,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

function agentContext(agent: EligibleAgent, correlationId: string): RequestContext {
  return {
    correlationId,
    actor: {
      principalId: agent.principalId,
      principalType: "agent",
      role: agent.role,
      agentId: agent.id,
      departmentId: agent.departmentId,
      permissions: [],
    },
  };
}

function selectionFromStored(stored: {
  authorization: "authorized" | "denied";
  reasonCode: string;
  departmentId: string;
  assignmentId: string | null;
  assignmentVersion: number | null;
  registryModelId: string;
  servingModel: string;
  modelDigest: string | null;
  adapterId: string | null;
  adapterVersion: string | null;
  policyVersion: string;
  budgetOutcome: string;
  resourceOutcome: string;
  executionVerification: "unverified" | "matched" | "mismatch";
  capabilityNote: string;
  servingInstanceId?: string | null;
  endpointReference?: string | null;
  agentId?: string | null;
  servingPolicyVersion?: string | null;
}): RoutingSelection {
  return {
    authorization: stored.authorization,
    reasonCode: stored.reasonCode as RoutingSelection["reasonCode"],
    departmentId: stored.departmentId,
    assignmentId: stored.assignmentId,
    assignmentVersion: stored.assignmentVersion,
    registryModelId: stored.registryModelId,
    servingModel: stored.servingModel,
    modelDigest: stored.modelDigest,
    adapterId: stored.adapterId,
    adapterVersion: stored.adapterVersion,
    policyVersion: stored.policyVersion,
    fallbackStatus: "disabled",
    budgetOutcome: stored.budgetOutcome === "denied" ? "denied" : "allowed",
    resourceOutcome: stored.resourceOutcome === "denied" ? "denied" : stored.resourceOutcome === "allowed" ? "allowed" : "memory_unknown",
    executionVerification: stored.executionVerification,
    capabilityNote: stored.capabilityNote,
    runtimeState: "readiness_unknown",
    evidenceCapturedAt: null,
    servingInstanceId: stored.servingInstanceId ?? null,
    endpointReference: stored.endpointReference ?? null,
    agentId: stored.agentId ?? null,
    servingPolicyVersion: stored.servingPolicyVersion ?? null,
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function zeroCounts(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function monitoringFindings(input: {
  models: Array<{ runtimeStatus: RuntimeStatus; displayName: string }>;
  heartbeats: Array<{ beatAt: string; role: string }>;
  tasks: ObjectiveTaskRecord[];
  deadLetters: number;
  now: number;
  staleAfterMs: number;
}) {
  const findings: Array<{ code: string; severity: "info" | "warning" | "critical"; summary: string }> = [];
  for (const model of input.models) {
    if (model.runtimeStatus === "unavailable" || model.runtimeStatus === "failed") {
      findings.push({
        code: "model_unavailable",
        severity: "critical",
        summary: `${model.displayName} is ${model.runtimeStatus}`,
      });
    }
  }
  if (input.heartbeats.some((beat) => input.now - Date.parse(beat.beatAt) > input.staleAfterMs)) {
    findings.push({ code: "worker_stale", severity: "warning", summary: "A worker heartbeat is stale" });
  }
  if (input.tasks.some((task) => task.status === "running" && task.leaseUntil && Date.parse(task.leaseUntil) < input.now)) {
    findings.push({ code: "task_stalled", severity: "warning", summary: "A running task lease has expired" });
  }
  if (input.deadLetters > 0) {
    findings.push({ code: "dead_letters", severity: "warning", summary: `${input.deadLetters} dead letters are open` });
  }
  return findings;
}
