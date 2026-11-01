import type { Agent, AgentRuntimeView, ExecutorCapabilityReport } from "@ai-colony/contracts";
import { isStaleRuntime } from "./stale.js";

export interface AgentExecutor {
  readonly kind: "lifecycle-only";
  capabilities(): ExecutorCapabilityReport;
  start(input: { agentId: string }): Promise<void>;
  stop(input: { agentId: string }): Promise<void>;
}

export interface RuntimeSession {
  executing: boolean;
  capabilities: ExecutorCapabilityReport;
}

export function assembleAgentStatus(input: {
  agent: Pick<Agent, "id" | "status" | "runtimeOwner" | "runtimeHeartbeatAt">;
  session: RuntimeSession | null;
  instanceId: string;
  nowMs: number;
  staleAfterMs: number;
}): AgentRuntimeView {
  const localExecuting = input.session?.executing === true;
  return {
    agentId: input.agent.id,
    status: input.agent.status,
    runtimeOwner: input.agent.runtimeOwner,
    runtimeHeartbeatAt: input.agent.runtimeHeartbeatAt,
    ownedByThisProcess: input.agent.runtimeOwner === input.instanceId,
    staleRuntime: isStaleRuntime({
      status: input.agent.status,
      heartbeatAt: input.agent.runtimeHeartbeatAt,
      localExecuting,
      nowMs: input.nowMs,
      staleAfterMs: input.staleAfterMs,
    }),
    localExecution: {
      attached: input.session !== null,
      activelyExecuting: localExecuting,
      executor: input.session?.capabilities ?? null,
    },
  };
}
