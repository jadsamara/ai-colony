import type { ExecutorCapabilityReport } from "@ai-colony/contracts";
import type { AgentExecutor } from "./status.js";

/**
 * Milestone 1 executor. It records that this process has started or stopped a
 * lifecycle session. It does not call a model, produce text, or learn.
 */
export class LifecycleOnlyExecutor implements AgentExecutor {
  readonly kind = "lifecycle-only" as const;
  private readonly running = new Set<string>();

  capabilities(): ExecutorCapabilityReport {
    return {
      kind: "lifecycle-only",
      inference: false,
      learning: false,
      training: false,
      description: "Tracks start and stop only. Does not run a model, reason, or learn.",
    };
  }

  async start(input: { agentId: string }): Promise<void> {
    this.running.add(input.agentId);
  }

  async stop(input: { agentId: string }): Promise<void> {
    this.running.delete(input.agentId);
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }
}
