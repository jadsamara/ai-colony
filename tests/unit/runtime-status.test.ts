import { describe, expect, it } from "vitest";
import {
  assembleAgentStatus,
  isStaleRuntime,
  LifecycleOnlyExecutor,
  recoveryStatus,
} from "@ai-colony/core";
import type { Agent } from "@ai-colony/contracts";

const agent = {
  id: "00000000-0000-4000-8000-000000000010",
  status: "running",
  runtimeOwner: "other-process",
  runtimeHeartbeatAt: new Date().toISOString(),
} as Pick<Agent, "id" | "status" | "runtimeOwner" | "runtimeHeartbeatAt">;

describe("runtime honesty", () => {
  it("does not report execution from a persisted running status alone", () => {
    const view = assembleAgentStatus({
      agent,
      session: null,
      instanceId: "this-process",
      nowMs: Date.now(),
      staleAfterMs: 30_000,
    });
    expect(view.status).toBe("running");
    expect(view.localExecution.activelyExecuting).toBe(false);
    expect(view.localExecution.attached).toBe(false);
    expect(view.localExecution.executor).toBeNull();
  });

  it("reports execution only for an attached started executor", () => {
    const executor = new LifecycleOnlyExecutor();
    const report = executor.capabilities();
    expect(report.inference).toBe(false);
    expect(report.learning).toBe(false);
    expect(report.training).toBe(false);
    const view = assembleAgentStatus({
      agent: { ...agent, runtimeOwner: "this-process" },
      session: { executing: true, capabilities: report },
      instanceId: "this-process",
      nowMs: Date.now(),
      staleAfterMs: 30_000,
    });
    expect(view.localExecution.activelyExecuting).toBe(true);
    expect(view.staleRuntime).toBe(false);
  });

  it("treats an expired transitional heartbeat as stale and maps recovery", () => {
    expect(
      isStaleRuntime({
        status: "running",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        localExecuting: false,
        nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
        staleAfterMs: 30_000,
      }),
    ).toBe(true);
    expect(recoveryStatus("running")).toBe("idle");
    expect(recoveryStatus("initializing")).toBe("failed");
    expect(recoveryStatus("stopping")).toBe("stopped");
    expect(recoveryStatus("idle")).toBeNull();
  });
});
