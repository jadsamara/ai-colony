import { randomUUID } from "node:crypto";
import { DomainError } from "../errors/domain-error.js";
import type {
  AgentCheckpoint,
  AgentMessage,
  AgentStatusReport,
  AgentTaskState,
  DedicatedServingInstance,
  DepartmentProfile,
  MemoryProposal,
  MemoryQuery,
  ToolRequest,
  ToolResult,
} from "./types.js";

export interface ModelTurn {
  text: string;
  tokens: number;
}

export interface DepartmentModelClient {
  complete(input: {
    instance: DedicatedServingInstance;
    objective: string;
    instructions: string;
  }): Promise<ModelTurn>;
}

export interface CheckpointStore {
  save(checkpoint: AgentCheckpoint): Promise<void>;
  load(agentId: string, taskId: string): Promise<AgentCheckpoint | null>;
}

export class MemoryStore {
  private readonly notes = new Map<string, string[]>();

  retrieve(query: MemoryQuery): string[] {
    return [...(this.notes.get(scopeKey(query.departmentId, query.namespace)) ?? [])];
  }

  propose(proposal: MemoryProposal): void {
    const key = scopeKey(proposal.departmentId, proposal.namespace);
    const current = this.notes.get(key) ?? [];
    current.push(proposal.summary);
    this.notes.set(key, current);
  }
}

export class InMemoryCheckpoints implements CheckpointStore {
  private readonly rows = new Map<string, AgentCheckpoint>();

  async save(checkpoint: AgentCheckpoint): Promise<void> {
    this.rows.set(`${checkpoint.agentId}:${checkpoint.task.taskId}`, checkpoint);
  }

  async load(agentId: string, taskId: string): Promise<AgentCheckpoint | null> {
    return this.rows.get(`${agentId}:${taskId}`) ?? null;
  }
}

type ModelAction =
  | { type: "final"; text: string }
  | { type: "tool"; name: string; input: string }
  | { type: "collaborate"; targetSlug: string; objective: string };

export class DepartmentAgentRuntime {
  readonly toolExecutions: string[] = [];
  readonly inbox: AgentMessage[] = [];
  private readonly tasks = new Map<string, AgentTaskState>();
  private closed = false;
  private dailyRequests = 0;

  constructor(
    readonly profile: DepartmentProfile,
    private instance: DedicatedServingInstance,
    private readonly client: DepartmentModelClient,
    private readonly memory: MemoryStore,
    private readonly checkpoints: CheckpointStore,
    private readonly colony: DepartmentColony,
    private readonly now: () => number = Date.now,
  ) {}

  get servingInstance(): DedicatedServingInstance {
    return this.instance;
  }

  async initialize(): Promise<void> {
    this.closed = false;
    if (this.instance.status === "configured") {
      this.instance = { ...this.instance, status: "starting" };
    }
  }

  async acceptTask(taskId: string, objective: string, correlationId: string, reportTo: string | null = null): Promise<void> {
    this.assertOpen();
    if (this.tasks.has(taskId)) {
      return;
    }
    if (this.dailyRequests >= this.profile.limits.dailyRequestLimit) {
      throw new DomainError("BUDGET_EXCEEDED", "Daily request limit is exhausted", 429);
    }
    this.dailyRequests += 1;
    this.tasks.set(taskId, {
      taskId,
      objective,
      correlationId,
      reportTo,
      status: "accepted",
      step: 0,
      tokens: 0,
      toolCalls: 0,
      retries: 0,
      result: null,
      failureReason: null,
      toolKeys: [],
      servingInstanceId: this.instance.instanceId,
      modelVersion: this.instance.modelVersion,
      endpointReference: this.instance.endpointReference,
      startedAtMs: this.now(),
    });
  }

  async executeTask(taskId: string): Promise<void> {
    this.assertOpen();
    const task = this.requireTask(taskId);
    this.assertPin(task);
    if (task.status === "completed") {
      return;
    }
    task.status = "running";
    while (task.step < this.profile.limits.maxSteps && task.status === "running") {
      if (this.now() - task.startedAtMs > this.profile.limits.maxWallClockMs) {
        await this.fail(task, "execution timeout");
        return;
      }
      let turn: ModelTurn;
      try {
        if (this.instance.status !== "ready") {
          throw new DomainError("SERVING_INSTANCE_UNAVAILABLE", "Dedicated serving instance is not ready", 503);
        }
        turn = await this.client.complete({
          instance: this.instance,
          objective: task.objective,
          instructions: this.profile.instructions,
        });
      } catch (error) {
        task.retries += 1;
        await this.checkpoint(taskId);
        if (task.retries <= this.profile.limits.maxRetries && this.instance.status === "ready") {
          continue;
        }
        const reason = error instanceof DomainError ? error.code : "SERVING_INSTANCE_UNAVAILABLE";
        await this.fail(task, reason);
        return;
      }
      task.tokens += turn.tokens;
      if (task.tokens > this.profile.limits.maxTokens) {
        await this.fail(task, "token budget exceeded");
        return;
      }
      const action = parseAction(turn.text);
      task.step += 1;
      if (action.type === "tool") {
        await this.requestTool({
          name: action.name,
          input: action.input,
          idempotencyKey: `${task.taskId}:${action.name}:${action.input}`,
        });
      } else if (action.type === "collaborate") {
        await this.sendMessage(this.collaborationRequest(task, action));
      } else {
        task.result = action.text;
        task.status = "completed";
        if (task.reportTo) {
          await this.sendMessage(this.resultMessage(task));
        }
      }
      await this.checkpoint(taskId);
      if (this.colony.seenLoop(task.taskId, task.step)) {
        await this.fail(task, "loop detected");
        return;
      }
    }
    if (task.status === "running") {
      await this.fail(task, "step limit exceeded");
    }
  }

  async requestTool(request: ToolRequest): Promise<ToolResult> {
    if (!this.profile.tools.includes(request.name)) {
      throw new DomainError("TOOL_DENIED", `Tool ${request.name} is not authorized`, 403);
    }
    if (this.toolExecutions.includes(request.idempotencyKey)) {
      return { name: request.name, output: "repeated", repeated: true };
    }
    const task = [...this.tasks.values()].find((candidate) => candidate.status === "running");
    if (task && task.toolCalls >= this.profile.limits.maxToolCalls) {
      throw new DomainError("BUDGET_EXCEEDED", "Tool-call budget is exhausted", 429);
    }
    if (task) {
      task.toolCalls += 1;
      task.toolKeys.push(request.idempotencyKey);
    }
    this.toolExecutions.push(request.idempotencyKey);
    return { name: request.name, output: `${request.name}:${request.input}`, repeated: false };
  }

  async sendMessage(message: AgentMessage): Promise<void> {
    if (message.senderAgentId !== this.profile.agentId) {
      throw new DomainError("MESSAGE_DENIED", "Agent cannot send as another agent", 403);
    }
    await this.colony.dispatch(message);
  }

  async receiveMessage(message: AgentMessage): Promise<void> {
    if (message.recipientAgentId !== this.profile.agentId) {
      throw new DomainError("MESSAGE_DENIED", "Message is for another agent", 403);
    }
    if (this.inbox.some((existing) => existing.idempotencyKey === message.idempotencyKey)) {
      return;
    }
    this.inbox.push({ ...message, deliveryStatus: "delivered" });
    if (message.messageType === "COLLABORATION_REQUEST") {
      const taskId = `${message.taskId}:${message.id}`;
      await this.acceptTask(taskId, message.payload.objective, message.correlationId, null);
      await this.executeTask(taskId);
      const task = this.requireTask(taskId);
      await this.colony.dispatch({
        ...message,
        id: randomUUID(),
        senderAgentId: this.profile.agentId,
        recipientAgentId: message.senderAgentId,
        senderDepartmentId: this.profile.departmentId,
        recipientDepartmentId: message.senderDepartmentId,
        messageType: "COLLABORATION_RESULT",
        payload: { objective: message.payload.objective, result: task.result ?? task.failureReason ?? "unavailable" },
        idempotencyKey: `${message.idempotencyKey}:result`,
        deliveryStatus: "accepted",
      });
    }
  }

  async retrieveMemory(query: MemoryQuery): Promise<string[]> {
    if (query.departmentId !== this.profile.departmentId || query.namespace !== this.profile.memoryNamespace) {
      throw new DomainError("MEMORY_SCOPE_DENIED", "Department cannot read that memory namespace", 403);
    }
    return this.memory.retrieve(query);
  }

  async proposeMemory(proposal: MemoryProposal): Promise<void> {
    if (proposal.departmentId !== this.profile.departmentId || proposal.namespace !== this.profile.memoryNamespace) {
      throw new DomainError("MEMORY_SCOPE_DENIED", "Department cannot write that memory namespace", 403);
    }
    this.memory.propose(proposal);
  }

  async checkpoint(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    await this.checkpoints.save({
      agentId: this.profile.agentId,
      departmentId: this.profile.departmentId,
      task: { ...task, toolKeys: [...task.toolKeys] },
      savedAt: new Date(this.now()).toISOString(),
    });
  }

  async resume(taskId: string): Promise<void> {
    const saved = await this.checkpoints.load(this.profile.agentId, taskId);
    if (!saved) {
      throw new DomainError("CHECKPOINT_MISSING", "Task checkpoint was not found", 404);
    }
    if (saved.task.servingInstanceId !== this.instance.instanceId || saved.task.modelVersion !== this.instance.modelVersion) {
      throw new DomainError("SERVING_MIGRATION_REQUIRED", "Pinned serving instance does not match this runtime", 409);
    }
    this.tasks.set(taskId, { ...saved.task, toolKeys: [...saved.task.toolKeys] });
    for (const key of saved.task.toolKeys) {
      if (!this.toolExecutions.includes(key)) {
        this.toolExecutions.push(key);
      }
    }
    if (saved.task.status !== "completed") {
      await this.executeTask(taskId);
    }
  }

  async reportStatus(): Promise<AgentStatusReport> {
    return {
      agentId: this.profile.agentId,
      departmentId: this.profile.departmentId,
      servingInstanceId: this.instance.instanceId,
      endpointReference: this.instance.endpointReference,
      modelVersion: this.instance.modelVersion,
      status: this.instance.status,
      activeTasks: [...this.tasks.values()].filter((task) => task.status === "running" || task.status === "accepted").length,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.instance = { ...this.instance, status: "stopped" };
  }

  markUnavailable(): void {
    this.instance = { ...this.instance, status: "unavailable" };
  }

  replaceInstance(instance: DedicatedServingInstance): void {
    if (instance.departmentId !== this.profile.departmentId) {
      throw new DomainError("SERVING_INSTANCE_SHARED", "Instance belongs to another department", 409);
    }
    this.instance = instance;
  }

  task(taskId: string): AgentTaskState | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task, toolKeys: [...task.toolKeys] } : undefined;
  }

  private assertPin(task: AgentTaskState): void {
    if (task.servingInstanceId !== this.instance.instanceId || task.modelVersion !== this.instance.modelVersion || task.endpointReference !== this.instance.endpointReference) {
      throw new DomainError("SERVING_MIGRATION_REQUIRED", "Task is pinned to another serving instance", 409);
    }
  }

  private async fail(task: AgentTaskState, reason: string): Promise<void> {
    task.status = "failed";
    task.failureReason = reason;
    await this.checkpoints.save({
      agentId: this.profile.agentId,
      departmentId: this.profile.departmentId,
      task: { ...task, toolKeys: [...task.toolKeys] },
      savedAt: new Date(this.now()).toISOString(),
    });
  }

  private requireTask(taskId: string): AgentTaskState {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new DomainError("TASK_NOT_FOUND", "Task is not accepted by this agent", 404);
    }
    return task;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DomainError("AGENT_STOPPED", "Department agent is stopped", 409);
    }
  }

  private collaborationRequest(task: AgentTaskState, action: Extract<ModelAction, { type: "collaborate" }>): AgentMessage {
    const recipient = this.colony.runtimeForSlug(action.targetSlug);
    return {
      id: randomUUID(),
      senderAgentId: this.profile.agentId,
      recipientAgentId: recipient.profile.agentId,
      senderDepartmentId: this.profile.departmentId,
      recipientDepartmentId: recipient.profile.departmentId,
      taskId: task.taskId,
      correlationId: task.correlationId,
      messageType: "COLLABORATION_REQUEST",
      payload: { objective: action.objective },
      authorization: "governed",
      deliveryStatus: "accepted",
      idempotencyKey: `${task.taskId}:${task.step}:${action.targetSlug}:${action.objective}`,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  private resultMessage(task: AgentTaskState): AgentMessage {
    const recipient = this.colony.runtimeForSlug(task.reportTo ?? "orchestration");
    return {
      id: randomUUID(),
      senderAgentId: this.profile.agentId,
      recipientAgentId: recipient.profile.agentId,
      senderDepartmentId: this.profile.departmentId,
      recipientDepartmentId: recipient.profile.departmentId,
      taskId: task.taskId,
      correlationId: task.correlationId,
      messageType: "COLLABORATION_RESULT",
      payload: { objective: task.objective, result: task.result ?? "" },
      authorization: "governed",
      deliveryStatus: "accepted",
      idempotencyKey: `${task.taskId}:result:${recipient.profile.slug}`,
      createdAt: new Date(this.now()).toISOString(),
    };
  }
}

export class DepartmentColony {
  readonly runtimes: ReadonlyMap<string, DepartmentAgentRuntime>;
  private readonly delivered = new Set<string>();
  private readonly loopKeys = new Set<string>();

  constructor(runtimes: ReadonlyMap<string, DepartmentAgentRuntime>) {
    this.runtimes = runtimes;
  }

  runtimeForSlug(slug: string): DepartmentAgentRuntime {
    const runtime = [...this.runtimes.values()].find((candidate) => candidate.profile.slug === slug);
    if (!runtime) {
      throw new DomainError("AGENT_UNAVAILABLE", `No runtime for ${slug}`, 404);
    }
    return runtime;
  }

  async dispatch(message: AgentMessage): Promise<void> {
    if (this.delivered.has(message.idempotencyKey)) {
      return;
    }
    const sender = [...this.runtimes.values()].find((runtime) => runtime.profile.agentId === message.senderAgentId);
    const recipient = [...this.runtimes.values()].find((runtime) => runtime.profile.agentId === message.recipientAgentId);
    if (!sender || !recipient) {
      throw new DomainError("MESSAGE_DENIED", "Message names an unknown agent", 403);
    }
    if (message.messageType === "COLLABORATION_REQUEST") {
      const allowed = sender.profile.collaborators.includes(recipient.profile.slug);
      if (!allowed) {
        throw new DomainError("MESSAGE_DENIED", "Collaboration is not authorized", 403);
      }
    }
    this.delivered.add(message.idempotencyKey);
    if (message.messageType === "COLLABORATION_RESULT") {
      recipient.inbox.push({ ...message, deliveryStatus: "delivered" });
      return;
    }
    await recipient.receiveMessage({ ...message, deliveryStatus: "accepted" });
  }

  seenLoop(taskId: string, step: number): boolean {
    const key = `${taskId}:${step}`;
    if (this.loopKeys.has(key)) {
      return true;
    }
    this.loopKeys.add(key);
    return false;
  }
}

export function createDepartmentColony(
  profiles: readonly DepartmentProfile[],
  instances: readonly DedicatedServingInstance[],
  clientFor: (instance: DedicatedServingInstance) => DepartmentModelClient,
  checkpoints: CheckpointStore = new InMemoryCheckpoints(),
  memory: MemoryStore = new MemoryStore(),
): DepartmentColony {
  const runtimes = new Map<string, DepartmentAgentRuntime>();
  const colony = new DepartmentColony(runtimes);
  for (const profile of profiles) {
    const instance = instances.find((candidate) => candidate.departmentId === profile.departmentId);
    if (!instance) {
      throw new DomainError("SERVING_INSTANCE_UNASSIGNED", `No serving instance for ${profile.slug}`, 409);
    }
    runtimes.set(profile.departmentId, new DepartmentAgentRuntime(profile, instance, clientFor(instance), memory, checkpoints, colony));
  }
  return colony;
}

function scopeKey(departmentId: string, namespace: string): string {
  return `${departmentId}:${namespace}`;
}

function parseAction(text: string): ModelAction {
  try {
    const parsed = JSON.parse(text) as { type?: string; text?: string; name?: string; input?: string; targetSlug?: string; objective?: string };
    if (parsed.type === "tool" && parsed.name) {
      return { type: "tool", name: parsed.name, input: parsed.input ?? "" };
    }
    if (parsed.type === "collaborate" && parsed.targetSlug && parsed.objective) {
      return { type: "collaborate", targetSlug: parsed.targetSlug, objective: parsed.objective };
    }
    if (parsed.type === "final" && parsed.text) {
      return { type: "final", text: parsed.text };
    }
  } catch {
    // Plain model text is a final answer.
  }
  return { type: "final", text };
}
