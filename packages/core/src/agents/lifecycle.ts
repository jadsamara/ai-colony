import type { AgentStatus } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";

/**
 * Complete agent lifecycle. `failed -> initializing` is listed here and also
 * requires an explicit authorizeRetry flag at the call site.
 * `stopped -> initializing` reinitializes an agent after a completed stop.
 */
export const AGENT_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  registered: ["initializing", "archived"],
  initializing: ["idle", "failed"],
  idle: ["running", "paused", "archived"],
  running: ["idle", "stopping", "failed"],
  paused: ["idle", "archived"],
  stopping: ["stopped", "failed"],
  stopped: ["initializing", "archived"],
  failed: ["initializing", "archived"],
  archived: [],
};

const TRANSITIONAL_STATUSES = new Set<AgentStatus>(["initializing", "running", "stopping"]);

export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

export function assertAgentTransition(
  from: AgentStatus,
  to: AgentStatus,
  options?: { authorizeRetry?: boolean },
): void {
  if (from === "failed" && to === "initializing" && options?.authorizeRetry !== true) {
    throw new DomainError(
      "RETRY_NOT_AUTHORIZED",
      "Moving a failed agent back to initializing requires explicit authorization",
      403,
      { from, to },
    );
  }
  if (!canTransitionAgent(from, to)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot transition agent from ${from} to ${to}`,
      409,
      {
        from,
        to,
      },
    );
  }
}

export function isTransitionalStatus(status: AgentStatus): boolean {
  return TRANSITIONAL_STATUSES.has(status);
}

export function recoveryStatus(status: AgentStatus): AgentStatus | null {
  switch (status) {
    case "initializing":
      return "failed";
    case "running":
      return "idle";
    case "stopping":
      return "stopped";
    default:
      return null;
  }
}
