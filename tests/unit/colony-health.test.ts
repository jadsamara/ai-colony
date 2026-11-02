import { describe, expect, it } from "vitest";
import { colonyHealthSchema } from "@ai-colony/contracts";
import { assessDispatcher, assessWorkers, buildRuntimeReport, type ComponentHealth } from "@ai-colony/core";
import type { LiveModelHealth } from "@ai-colony/contracts";

const now = Date.parse("2026-11-02T20:00:00.000Z");

describe("colony runtime health", () => {
  it("reports a stale worker heartbeat without calling it running", () => {
    const workers = assessWorkers({
      heartbeats: [{ role: "ceo", beatAt: "2026-11-01T05:48:00.000Z" }],
      processSeen: false,
      now,
      staleAfterMs: 30_000,
    });
    expect(workers.state).toBe("stale");
  });

  it("reports unknown when worker evidence is missing", () => {
    expect(
      assessWorkers({ heartbeats: [], processSeen: null, now, staleAfterMs: 30_000 }).state,
    ).toBe("unknown");
  });

  it("keeps a stopped dispatcher distinct from pending records", () => {
    const dispatcher = assessDispatcher({ processSeen: false, pending: 20 });
    expect(dispatcher).toMatchObject({ state: "stopped" });
    expect(dispatcher.evidence).toContain("20 pending");
  });

  it("reports partial infrastructure without promoting unknown checks to failures", () => {
    const report = buildRuntimeReport({
      checkedAt: "2026-11-02T20:00:00.000Z",
      postgres: { connected: false, database: null, dataDirectory: null, session: "unknown" },
      rabbitReachable: null,
      apiListening: false,
      workers: { heartbeats: [], processSeen: null, now, staleAfterMs: 30_000 },
      dispatcher: { processSeen: null, pending: null },
      registry: null,
      training: { provider: "scripted", processSeen: null, lastExperimentAt: null },
      model: unreachableModel(),
      outbox: {
        pending: 0,
        publishing: 0,
        published: 0,
        failed: 0,
        oldest_pending_age_ms: null,
        delivery_guarantee: "at-least-once",
      },
    });
    expect(colonyHealthSchema.parse(report).model.inference_ready).toBe("unavailable");
    expect(state(report.components, "postgresql")).toBe("unavailable");
    expect(state(report.components, "rabbitmq")).toBe("unknown");
    expect(state(report.components, "fastify-api")).toBe("stopped");
    expect(state(report.components, "langgraph-workers")).toBe("unknown");
    expect(state(report.components, "outbox-dispatcher")).toBe("unknown");
    expect(state(report.components, "training-service")).toBe("unknown");
    expect(state(report.components, "ollama")).toBe("unavailable");
  });
});

function state(components: ComponentHealth[], name: string): string | undefined {
  return components.find((component) => component.component === name)?.state;
}

function unreachableModel(): LiveModelHealth {
  return {
    alias: "qwen3:8b",
    persisted_status: {
      runtimeStatus: "ready",
      expectedAlias: "qwen3:8b",
      loadedModelId: "qwen3:8b",
      endpointUrl: "http://127.0.0.1:11434",
      lastError: null,
      probedAt: "2026-11-01T05:14:13.861Z",
    },
    live_status: {
      registered: true,
      artifacts_present: "present",
      reachable: false,
      installed: false,
      loaded: false,
      unavailable: true,
    },
    checked_at: "2026-11-02T20:00:00.000Z",
    stale: false,
    inference_ready: "unavailable",
    evidence: {
      version: null,
      installed_models: [],
      loaded_models: [],
      errors: [{ endpoint: "/api/version", message: "connection refused" }],
      last_successful_inference_at: null,
    },
  };
}
