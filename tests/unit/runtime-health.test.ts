import { describe, expect, it } from "vitest";
import { liveModelHealthSchema } from "@ai-colony/contracts";
import { describeModelHealth, inferenceReadiness } from "@ai-colony/core";
import { OllamaStatusClient, ollamaProbeUrl } from "@ai-colony/inference";

const alias = "qwen3:8b";
const checkedAt = "2026-11-02T20:00:00.000Z";

describe("live model health", () => {
  it("never reports a current ready state when Ollama is unreachable", async () => {
    const calls: string[] = [];
    const probe = statusClient({
      fetch: async (url) => {
        calls.push(String(url));
        throw Object.assign(new Error("connect ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    const observation = await probe.inspect();
    const persisted = readyRecord();
    const live = describeModelHealth({
      alias,
      registered: true,
      artifacts: "present",
      persisted,
      observation,
      lastSuccessfulInferenceAt: checkedAt,
      now: Date.parse(checkedAt),
      freshnessMs: 60_000,
    });
    expect(calls).toHaveLength(1);
    expect(live.live_status.reachable).toBe(false);
    expect(live.inference_ready).toBe("unavailable");
    expect(live.persisted_status?.runtimeStatus).toBe("ready");
    expect(persisted.runtimeStatus).toBe("ready");
    expect(liveModelHealthSchema.parse(live).inference_ready).toBe("unavailable");
  });

  it("reports an installed model that is not loaded as unverified", async () => {
    const live = await described(responses({
      "/api/version": JSON.stringify({ version: "0.40.13" }),
      "/api/tags": JSON.stringify({ models: [{ name: alias }, { name: "embeddinggemma:latest" }] }),
      "/api/ps": JSON.stringify({ models: [] }),
    }));
    expect(live.live_status).toMatchObject({ reachable: true, installed: true, loaded: false, unavailable: false });
    expect(live.inference_ready).toBe("unknown");
  });

  it("reports a missing model and an HTTP error without treating the stored row as live", async () => {
    const missing = await described(responses({
      "/api/version": JSON.stringify({ version: "0.40.13" }),
      "/api/tags": JSON.stringify({ models: [{ name: "embeddinggemma:latest" }] }),
      "/api/ps": JSON.stringify({ models: [] }),
    }));
    expect(missing.live_status.installed).toBe(false);
    expect(missing.inference_ready).toBe("unknown");
    expect(missing.persisted_status?.runtimeStatus).toBe("ready");

    const failed = await described(async () => new Response("no", { status: 503 }));
    expect(failed.live_status.reachable).toBe(false);
    expect(failed.evidence.errors[0]?.message).toBe("HTTP 503");
    expect(failed.inference_ready).toBe("unavailable");
  });

  it("keeps inference readiness unknown when the model is loaded without recent inference", async () => {
    const live = await described(
      responses({
        "/api/version": JSON.stringify({ version: "0.40.13" }),
        "/api/tags": JSON.stringify({ models: [{ name: alias }] }),
        "/api/ps": JSON.stringify({ models: [{ name: alias }] }),
      }),
      null,
    );
    expect(live.live_status.loaded).toBe(true);
    expect(live.inference_ready).toBe("unknown");
  });

  it("verifies readiness only from a recent successful inference", () => {
    expect(
      inferenceReadiness({
        reachable: true,
        loaded: true,
        lastSuccessfulInferenceAt: checkedAt,
        now: Date.parse(checkedAt) + 1_000,
        freshnessMs: 60_000,
      }),
    ).toBe("verified");
    expect(
      inferenceReadiness({
        reachable: false,
        loaded: true,
        lastSuccessfulInferenceAt: checkedAt,
        now: Date.parse(checkedAt),
        freshnessMs: 60_000,
      }),
    ).toBe("unavailable");
  });

  it("bounds a timeout and records a safe malformed-response error", async () => {
    const started = Date.now();
    const hanging = new OllamaStatusClient({
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 30,
      minIntervalMs: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        }),
    });
    const timedOut = await hanging.inspect();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(timedOut.errors).toEqual([{ endpoint: "/api/version", message: "timeout" }]);
    expect(timedOut.reachable).toBe(false);

    const malformed = await described(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/version") {
        return json("{");
      }
      return json("{}");
    });
    expect(malformed.inference_ready).toBe("unavailable");
    expect(malformed.evidence.errors[0]?.message).toBe("malformed JSON");
  });

  it("marks cached evidence stale after the freshness window", async () => {
    let now = Date.parse(checkedAt);
    const calls: string[] = [];
    const client = new OllamaStatusClient({
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 3_000,
      freshnessMs: 60_000,
      minIntervalMs: 120_000,
      now: () => now,
      fetch: async (url) => {
        calls.push(new URL(String(url)).pathname);
        return json(bodyFor(new URL(String(url)).pathname));
      },
    });
    expect((await client.inspect()).stale).toBe(false);
    now += 61_000;
    const expired = await client.inspect();
    expect(expired.stale).toBe(true);
    expect(calls).toEqual(["/api/version", "/api/tags", "/api/ps"]);
  });

  it("does not call an inference, load, or download endpoint", async () => {
    const methods: string[] = [];
    const paths: string[] = [];
    const probe = statusClient({
      fetch: async (url, init) => {
        methods.push(init?.method ?? "GET");
        paths.push(new URL(String(url)).pathname);
        return json(bodyFor(new URL(String(url)).pathname));
      },
    });
    await probe.inspect();
    expect(methods).toEqual(["GET", "GET", "GET"]);
    expect(paths).toEqual(["/api/version", "/api/tags", "/api/ps"]);
    expect(() => ollamaProbeUrl("http://127.0.0.1:11434", "/api/generate")).toThrow(/Refusing/);
    expect(() => ollamaProbeUrl("http://127.0.0.1:11434", "/api/chat")).toThrow(/Refusing/);
    expect(() => ollamaProbeUrl("http://127.0.0.1:11434", "/api/embeddings")).toThrow(/Refusing/);
    expect(() => ollamaProbeUrl("http://127.0.0.1:11434", "/api/pull")).toThrow(/Refusing/);
  });
});

function readyRecord() {
  return {
    runtimeStatus: "ready",
    expectedAlias: alias,
    loadedModelId: alias,
    endpointUrl: "http://127.0.0.1:11434",
    lastError: null,
    probedAt: "2026-11-01T05:14:13.861Z",
  };
}

function statusClient(options: { fetch: typeof fetch }): OllamaStatusClient {
  return new OllamaStatusClient({
    baseUrl: "http://127.0.0.1:11434",
    timeoutMs: 3_000,
    freshnessMs: 60_000,
    minIntervalMs: 0,
    now: () => Date.parse(checkedAt),
    fetch: options.fetch,
  });
}

function responses(bodies: Record<string, string>): typeof fetch {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    const body = bodies[path];
    if (!body) {
      throw new Error(`unexpected ${path}`);
    }
    return json(body);
  };
}

async function described(fetchImpl: typeof fetch, lastInference: string | null = "2026-11-01T05:14:13.861Z") {
  const observation = await statusClient({ fetch: fetchImpl }).inspect();
  return describeModelHealth({
    alias,
    registered: true,
    artifacts: "present",
    persisted: readyRecord(),
    observation,
    lastSuccessfulInferenceAt: lastInference,
    now: Date.parse(checkedAt),
    freshnessMs: 60_000,
  });
}

function bodyFor(path: string): string {
  if (path === "/api/version") {
    return JSON.stringify({ version: "0.40.13" });
  }
  if (path === "/api/tags") {
    return JSON.stringify({ models: [{ name: alias }] });
  }
  return JSON.stringify({ models: [] });
}

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}
