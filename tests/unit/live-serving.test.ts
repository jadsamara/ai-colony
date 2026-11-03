import { readFileSync } from "node:fs";
import { InferenceError, SHARED_QWEN3_8B_MODEL_ID, assessLiveServing, promotionAllowed } from "@ai-colony/core";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { executePrepared } from "@ai-colony/workflows";
import { describe, expect, it } from "vitest";

const qwen = { name: "qwen3:8b", digest: "sha256:qwen", sizeBytes: 5_200_000_000 };
const embedding = { name: "embeddinggemma:latest", digest: "sha256:embed", sizeBytes: 621_000_000 };
const otherLarge = { name: "qwen3:4b", digest: "sha256:small", sizeBytes: 2_500_000_000 };

describe("live serving capacity", () => {
  it("allows an installed unloaded shared model and does not claim resident memory", () => {
    const assessed = assessLiveServing({
      requestedAlias: "qwen3:8b",
      reachable: true,
      stale: false,
      checkedAt: "2026-11-03T04:00:00.000Z",
      installed: [qwen, embedding],
      loaded: [],
    });
    expect(assessed.resourceAllowed).toBe(true);
    expect(assessed.memoryKnown).toBe(false);
    expect(assessed.enforcement).toBe("not_measured");
    expect(assessed.evidence.state).toBe("installed");
    expect(assessed.evidence.digest).toBe("sha256:qwen");
    expect(assessed.evidence.servingTag).toBe("qwen3:8b");
  });

  it("denies a second large loaded model without selecting a fallback", () => {
    const assessed = assessLiveServing({
      requestedAlias: "qwen3:8b",
      reachable: true,
      stale: false,
      checkedAt: "2026-11-03T04:00:00.000Z",
      installed: [qwen],
      loaded: [otherLarge],
    });
    expect(assessed.resourceAllowed).toBe(false);
    expect(assessed.enforcement).toBe("distinct_large_model_limit");
    expect(assessed.evidence.digest).toBe("sha256:qwen");
    expect(assessed.resourceDetail).not.toContain("qwen3:4b");
  });

  it("allows a small loaded embedding beside the requested model", () => {
    const assessed = assessLiveServing({
      requestedAlias: "qwen3:8b",
      reachable: true,
      stale: false,
      checkedAt: "2026-11-03T04:00:00.000Z",
      installed: [qwen, embedding],
      loaded: [embedding],
    });
    expect(assessed.resourceAllowed).toBe(true);
    expect(assessed.evidence.state).toBe("installed");
  });

  it("records known memory only for the loaded requested model", () => {
    const assessed = assessLiveServing({
      requestedAlias: "qwen3:8b",
      reachable: true,
      stale: false,
      checkedAt: "2026-11-03T04:00:00.000Z",
      installed: [qwen],
      loaded: [{ ...qwen, sizeBytes: 6_000_000_000 }],
    });
    expect(assessed.memoryKnown).toBe(true);
    expect(assessed.evidence.state).toBe("loaded");
    expect(assessed.evidence.artifactBytes).toBe(5_200_000_000);
  });

  it("fails closed when a different loaded model has no size", () => {
    const assessed = assessLiveServing({
      requestedAlias: "qwen3:8b",
      reachable: true,
      stale: false,
      checkedAt: "2026-11-03T04:00:00.000Z",
      installed: [qwen],
      loaded: [{ name: "unknown:latest", digest: null, sizeBytes: null }],
    });
    expect(assessed.resourceAllowed).toBe(false);
  });

  it("does not attach another model's digest when the alias is absent", () => {
    const assessed = assessLiveServing({
      requestedAlias: "qwen3:8b",
      reachable: true,
      stale: false,
      checkedAt: "2026-11-03T04:00:00.000Z",
      installed: [embedding],
      loaded: [],
    });
    expect(assessed.evidence.digest).toBeNull();
    expect(assessed.evidence.servingTag).toBeNull();
    expect(assessed.evidence.state).toBe("registered");
  });
});

describe("execution digest fail-closed", () => {
  it("fails the request when the backend reports a different digest", async () => {
    const failures: string[] = [];
    const provider = new ScriptedInferenceProvider(() => ({
      text: "4",
      servedModel: "qwen3:8b",
      servedDigest: "sha256:other",
      usage: { inputTokens: 1, outputTokens: 1, source: "observed" },
      latencyMs: 3,
    }));
    const service = {
      async memoryMessages() {
        return null;
      },
      async completeGeneration() {
        return "accepted" as const;
      },
      async failGeneration(_id: string, error: string) {
        failures.push(error);
      },
    };
    await expect(executePrepared(service as never, provider, prepared(), {
      memoryProfile: "shared",
      alias: "qwen3:8b",
      operationalAlias: null,
      temperature: 0,
      maxOutputTokens: 8,
      timeoutMs: 1000,
      rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
      globalConcurrency: 1,
      departmentConcurrency: 1,
      routingEvidence: {
        state: "installed",
        capturedAt: "2026-11-03T04:00:00.000Z",
        digest: "sha256:qwen",
        servingTag: "qwen3:8b",
        artifactBytes: qwen.sizeBytes,
        loadedCount: 0,
      },
    })).rejects.toBeInstanceOf(InferenceError);
    expect(failures).toEqual(["Resolved digest did not match the pinned routing decision"]);
  });
});

describe("evaluation isolation", () => {
  it("keeps evaluation off the department router and out of automatic promotion", () => {
    const evaluation = readFileSync("packages/core/src/evaluation/evaluation-service.ts", "utf8");
    const ledger = readFileSync("packages/core/src/objectives/objective-service.ts", "utf8");
    expect(evaluation).not.toContain("evaluateRouting");
    expect(evaluation).not.toContain("ledger_snapshots");
    expect(ledger).not.toContain("insertSnapshot");
    expect(promotionAllowed({
      classification: "specialist",
      kind: "contribution",
      relevantToRecipientDomain: true,
      provenance: "model_generated",
      validated: true,
      expired: false,
      forgotten: false,
      requesterPrivate: false,
      recipientAuthorized: true,
    }).allowed).toBe(false);
    const paired = readFileSync("packages/core/src/evaluation/paired.ts", "utf8");
    expect(paired).toContain('deploymentAuthorization: "separate_decision_required"');
  });
});

function prepared() {
  return {
    action: "generate" as const,
    requestId: "req-live",
    purpose: "specialist" as const,
    objectiveId: "obj",
    taskId: "task",
    attempt: 1,
    reservedOutputTokens: 8,
    messages: [{ role: "user" as const, content: "2+2" }],
    registryModelId: SHARED_QWEN3_8B_MODEL_ID,
    intendedModelId: SHARED_QWEN3_8B_MODEL_ID,
    modelAlias: "qwen3:8b",
    temperature: 0,
    maxOutputTokens: 8,
    timeoutMs: 1000,
    cachedText: null,
  };
}
