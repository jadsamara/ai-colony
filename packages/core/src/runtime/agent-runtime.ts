import { randomUUID } from "node:crypto";
import type { Agent, AgentRuntimeView, AgentStatus, LifecycleEvent } from "@ai-colony/contracts";
import { assertAgentTransition, recoveryStatus } from "../agents/lifecycle.js";
import { snapshot, type RequestContext } from "../context.js";
import { DomainError, notFound } from "../errors/domain-error.js";
import type { Authorizer } from "../governance/authorizer.js";
import { permissionsForRole } from "../governance/permissions.js";
import { decodeCursor } from "../pagination.js";
import type { Page, Persistence, Repositories } from "../ports/repositories.js";
import { LifecycleOnlyExecutor } from "./lifecycle-only-executor.js";
import { assembleAgentStatus } from "./status.js";
import { isStaleRuntime } from "./stale.js";
import type { AgentExecutor } from "./status.js";

interface Session {
  executor: AgentExecutor;
  executing: boolean;
}

interface RuntimeWrite {
  owner: string | null;
  heartbeat: boolean;
}

export class AgentRuntime {
  readonly instanceId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly persistence: Persistence,
    private readonly authorizer: Authorizer,
    private readonly staleAfterMs: number,
  ) {
    if (this.staleAfterMs > 0) {
      const intervalMs = Math.min(10_000, Math.max(1_000, Math.floor(this.staleAfterMs / 3)));
      this.heartbeatTimer = setInterval(() => {
        void this.touchHeartbeats();
      }, intervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  async reconcileStaleAgents(): Promise<void> {
    if (this.closed) {
      return;
    }
    const cutoff = new Date(Date.now() - this.staleAfterMs);
    const staleAgents = await this.persistence.repos.agents.listStaleRuntimeAgents(cutoff);
    const actor = this.systemActor();
    for (const candidate of staleAgents) {
      await this.persistence.transaction(async (repos) => {
        const locked = await repos.agents.lockById(candidate.id);
        if (!locked || this.sessions.get(locked.id)?.executing) {
          return;
        }
        if (
          !isStaleRuntime({
            status: locked.status,
            heartbeatAt: locked.runtimeHeartbeatAt,
            localExecuting: false,
            nowMs: Date.now(),
            staleAfterMs: this.staleAfterMs,
          })
        ) {
          return;
        }
        const to = recoveryStatus(locked.status);
        if (!to) {
          return;
        }
        const session = this.sessions.get(locked.id);
        if (session) {
          await session.executor.stop({ agentId: locked.id });
          session.executing = false;
        }
        await this.writeTransition(
          repos,
          { actor, correlationId: randomUUID() },
          locked.id,
          to,
          "stale_runtime_recovered",
          {},
          { owner: null, heartbeat: false },
        );
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const actor = this.systemActor();
    for (const [agentId, session] of this.sessions) {
      try {
        await session.executor.stop({ agentId });
      } catch {
        // Lifecycle-only stop has no external dependency. Continue releasing state.
      }
      session.executing = false;
      await this.persistence.transaction(async (repos) => {
        const agent = await repos.agents.lockById(agentId);
        if (!agent || (agent.runtimeOwner !== null && agent.runtimeOwner !== this.instanceId)) {
          return;
        }
        if (agent.status === "running") {
          await this.writeTransition(
            repos,
            { actor, correlationId: randomUUID() },
            agentId,
            "stopping",
            "process_shutdown",
            {},
            { owner: this.instanceId, heartbeat: true },
          );
          await this.writeTransition(
            repos,
            { actor, correlationId: randomUUID() },
            agentId,
            "stopped",
            "process_shutdown",
            {},
            { owner: null, heartbeat: false },
          );
        } else if (agent.status === "initializing") {
          await this.writeTransition(
            repos,
            { actor, correlationId: randomUUID() },
            agentId,
            "failed",
            "process_shutdown",
            {},
            { owner: null, heartbeat: false },
          );
        } else if (agent.status === "stopping") {
          await this.writeTransition(
            repos,
            { actor, correlationId: randomUUID() },
            agentId,
            "stopped",
            "process_shutdown",
            {},
            { owner: null, heartbeat: false },
          );
        }
      });
    }
    this.sessions.clear();
  }

  async attachExecutor(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:update");
    const agent = await this.requireAgent(agentId);
    if (agent.status === "archived") {
      throw new DomainError("INVALID_TRANSITION", "Archived agents cannot attach an executor", 409);
    }
    const existing = this.sessions.get(agentId);
    if (existing?.executing) {
      throw new DomainError("EXECUTOR_BUSY", "Stop the agent before replacing its executor", 409);
    }
    this.assertLocalControl(agent);
    this.sessions.set(agentId, { executor: new LifecycleOnlyExecutor(), executing: false });
    return this.view(agent);
  }

  async initialize(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:start");
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "initializing",
        "initialize",
        {},
        {
          owner: this.instanceId,
          heartbeat: true,
        },
      );
    });
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "idle",
        "initialization_complete",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async start(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:start");
    const existing = await this.requireAgent(agentId);
    assertAgentTransition(existing.status, "running");
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new DomainError(
        "EXECUTOR_NOT_ATTACHED",
        "Refusing to mark the agent running because no executor is attached in this process",
        409,
      );
    }
    await session.executor.start({ agentId });
    try {
      await this.persistence.transaction(async (repos) => {
        await this.writeTransition(
          repos,
          ctx,
          agentId,
          "running",
          "start",
          {},
          {
            owner: this.instanceId,
            heartbeat: true,
          },
        );
      });
      session.executing = true;
    } catch (error) {
      session.executing = false;
      await session.executor.stop({ agentId });
      throw error;
    }
    return this.getStatus(agentId);
  }

  async yieldExecution(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:stop");
    const existing = await this.requireAgent(agentId);
    this.assertLocalControl(existing);
    assertAgentTransition(existing.status, "idle");
    const session = this.sessions.get(agentId);
    if (session?.executing) {
      await session.executor.stop({ agentId });
      session.executing = false;
    }
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "idle",
        "yield",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async stop(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:stop");
    const existing = await this.requireAgent(agentId);
    this.assertLocalControl(existing);
    assertAgentTransition(existing.status, "stopping");
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "stopping",
        "stop",
        {},
        {
          owner: this.instanceId,
          heartbeat: true,
        },
      );
    });
    const session = this.sessions.get(agentId);
    if (session) {
      await session.executor.stop({ agentId });
      session.executing = false;
    }
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "stopped",
        "stop_complete",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async pause(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:stop");
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "paused",
        "pause",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async resume(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:start");
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "idle",
        "resume",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async fail(ctx: RequestContext, agentId: string, reason: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:stop");
    const existing = await this.requireAgent(agentId);
    assertAgentTransition(existing.status, "failed");
    const session = this.sessions.get(agentId);
    if (session?.executing) {
      await session.executor.stop({ agentId });
      session.executing = false;
    }
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "failed",
        reason,
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async retry(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:start");
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "initializing",
        "authorized_retry",
        { authorizeRetry: true },
        { owner: this.instanceId, heartbeat: true },
      );
    });
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "idle",
        "initialization_complete",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    return this.getStatus(agentId);
  }

  async archive(ctx: RequestContext, agentId: string): Promise<AgentRuntimeView> {
    this.assertOpen();
    this.authorizer.assert(ctx.actor, "agent:archive");
    if (this.sessions.get(agentId)?.executing) {
      throw new DomainError("INVALID_TRANSITION", "Stop the agent before archiving it", 409);
    }
    await this.persistence.transaction(async (repos) => {
      await this.writeTransition(
        repos,
        ctx,
        agentId,
        "archived",
        "archive",
        {},
        {
          owner: null,
          heartbeat: false,
        },
      );
    });
    this.sessions.delete(agentId);
    return this.getStatus(agentId);
  }

  async getStatus(agentId: string): Promise<AgentRuntimeView> {
    return this.view(await this.requireAgent(agentId));
  }

  async listEvents(
    agentId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<LifecycleEvent>> {
    await this.requireAgent(agentId);
    return this.persistence.repos.lifecycle.listByAgent(agentId, {
      limit: query.limit,
      cursor: query.cursor ? decodeCursor(query.cursor) : null,
    });
  }

  private async writeTransition(
    repos: Repositories,
    ctx: RequestContext,
    agentId: string,
    to: AgentStatus,
    reason: string,
    options: { authorizeRetry?: boolean },
    runtime: RuntimeWrite,
  ): Promise<Agent> {
    const current = await repos.agents.lockById(agentId);
    if (!current) {
      throw notFound("Agent");
    }
    assertAgentTransition(current.status, to, options);
    const updated = await repos.agents.update(agentId, {
      status: to,
      runtimeOwner: runtime.owner,
      runtimeHeartbeatAt: runtime.heartbeat ? new Date().toISOString() : null,
    });
    await repos.lifecycle.append({
      agentId,
      fromStatus: current.status,
      toStatus: to,
      reason,
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      correlationId: ctx.correlationId,
    });
    await repos.audit.append({
      eventType: "agent.lifecycle",
      actorId: ctx.actor.principalId,
      actorType: ctx.actor.principalType,
      targetType: "agent",
      targetId: agentId,
      action: "transition",
      correlationId: ctx.correlationId,
      beforeState: snapshot(current),
      afterState: snapshot(updated),
      metadata: { from: current.status, to, reason },
    });
    return updated;
  }

  private assertLocalControl(agent: Agent): void {
    const localExecuting = this.sessions.get(agent.id)?.executing === true;
    const stale = isStaleRuntime({
      status: agent.status,
      heartbeatAt: agent.runtimeHeartbeatAt,
      localExecuting,
      nowMs: Date.now(),
      staleAfterMs: this.staleAfterMs,
    });
    const owns =
      agent.runtimeOwner === null || agent.runtimeOwner === this.instanceId || localExecuting;
    if (!owns && !stale) {
      throw new DomainError(
        "RUNTIME_OWNED_ELSEWHERE",
        "This process does not own the agent runtime",
        409,
      );
    }
  }

  private async requireAgent(agentId: string): Promise<Agent> {
    const agent = await this.persistence.repos.agents.findById(agentId);
    if (!agent) {
      throw notFound("Agent");
    }
    return agent;
  }

  private view(agent: Agent): AgentRuntimeView {
    const session = this.sessions.get(agent.id);
    return assembleAgentStatus({
      agent,
      session: session
        ? { executing: session.executing, capabilities: session.executor.capabilities() }
        : null,
      instanceId: this.instanceId,
      nowMs: Date.now(),
      staleAfterMs: this.staleAfterMs,
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DomainError("SERVICE_UNAVAILABLE", "The agent runtime is shutting down", 503);
    }
  }

  private systemActor(): RequestContext["actor"] {
    return {
      principalId: "system:reconciler",
      principalType: "system",
      role: "system_administrator",
      agentId: null,
      departmentId: null,
      permissions: permissionsForRole("system_administrator"),
    };
  }

  private async touchHeartbeats(): Promise<void> {
    if (this.closed) {
      return;
    }
    const ids = [...this.sessions.entries()]
      .filter(([, session]) => session.executing)
      .map(([agentId]) => agentId);
    if (ids.length === 0) {
      return;
    }
    try {
      await this.persistence.repos.agents.touchHeartbeats(ids, new Date());
    } catch {
      // A missed heartbeat is recovered as a stale runtime after the deadline.
    }
  }
}
