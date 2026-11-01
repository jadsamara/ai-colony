import type { AgentStatus } from "@ai-colony/contracts";
import { isTransitionalStatus } from "../agents/lifecycle.js";

export function isStaleRuntime(input: {
  status: AgentStatus;
  heartbeatAt: string | null;
  localExecuting: boolean;
  nowMs: number;
  staleAfterMs: number;
}): boolean {
  if (input.localExecuting || !isTransitionalStatus(input.status)) {
    return false;
  }
  if (!input.heartbeatAt) {
    return true;
  }
  const heartbeatMs = Date.parse(input.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) {
    return true;
  }
  return heartbeatMs < input.nowMs - input.staleAfterMs;
}
