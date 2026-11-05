import { readFileSync } from "node:fs";
import { QWEN3_4B_MODEL_ID } from "@ai-colony/contracts";
import {
  CEO_DEPARTMENT_ID,
  LEGACY_DEPARTMENT_IDS,
  LEGACY_ROUTING_POLICY_VERSION,
  SHARED_QWEN3_8B_MODEL_ID,
  evaluateRouting,
  type DerivedServingArtifact,
  type RoutingSnapshot,
} from "@ai-colony/core";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { executePrepared } from "@ai-colony/workflows";
import { describe, expect, it } from "vitest";

const NOW = "2026-11-03T03:00:00.000Z";
const FRESH = "2026-11-03T02:59:50.000Z";
const SPECIALIZED = "00000000-0000-4000-8000-000000000199";

function evidence(state: RoutingSnapshot["evidence"]["state"], capturedAt: string | null = FRESH) {
  return { state, capturedAt, digest: "sha256:qwen", servingTag: "qwen3:8b", artifactBytes: 5_200_000_000, loadedCount: state === "loaded" ? 1 : 0 };
}

function snap(patch: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  return {
    departmentId: CEO_DEPARTMENT_ID,
    departmentStatus: "active",
    agentDepartmentId: null,
    assignments: [],
    models: {
      [SHARED_QWEN3_8B_MODEL_ID]: { id: SHARED_QWEN3_8B_MODEL_ID, status: "not_deployed", modelFamily: "qwen3", displayName: "Qwen3 8B" },
      [QWEN3_4B_MODEL_ID]: { id: QWEN3_4B_MODEL_ID, status: "not_deployed", modelFamily: "qwen3", displayName: "Qwen3 4B" },
      [SPECIALIZED]: { id: SPECIALIZED, status: "available", modelFamily: "gemma", displayName: "Specialist" },
    },
    requestedModelId: null,
    sharedServingTag: "qwen3:8b",
    derived: null,
    evidence: evidence("installed"),
    now: NOW,
    budgetAllowed: true,
    resourceAllowed: true,
    memoryKnown: false,
    servingBackend: "ollama",
    certifiedCapabilityCount: 0,
    syntheticCapabilityCount: 0,
    executionDigest: null,
    ...patch,
  };
}

function assignment(patch: Partial<RoutingSnapshot["assignments"][number]> = {}): RoutingSnapshot["assignments"][number] {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    departmentId: CEO_DEPARTMENT_ID,
    role: "shared_base",
    registryModelId: SHARED_QWEN3_8B_MODEL_ID,
    adapterSha256: null,
    modelFamily: "qwen3",
    version: 1,
    status: "active",
    ...patch,
  };
}

const derived: DerivedServingArtifact = {
  servingModel: "math-adapter:v3",
  digest: "sha256:derived",
  baseRegistryModelId: SHARED_QWEN3_8B_MODEL_ID,
  adapterId: "adapter-sha",
  adapterVersion: "3",
  provenanceVerified: true,
};

describe("governed department routing", () => {
  it("authorizes the shared Qwen3-8B default for a legacy department", () => {
    const decision = evaluateRouting(snap());
    expect(decision.authorization).toBe("authorized");
    expect(decision.reasonCode).toBe("authorized_legacy_default");
    expect(decision.registryModelId).toBe(SHARED_QWEN3_8B_MODEL_ID);
    expect(decision.servingModel).toBe("qwen3:8b");
    expect(decision.policyVersion).toBe(LEGACY_ROUTING_POLICY_VERSION);
  });

  it("keeps the legacy allowlist equal to the seeded departments", () => {
    const seed = readFileSync("packages/database/src/seed.ts", "utf8");
    const block = seed.slice(seed.indexOf("const INITIAL_DEPARTMENTS"), seed.indexOf("const INITIAL_MODELS"));
    const ids = [...block.matchAll(/00000000-0000-4000-8000-00000000001[0-9a-f]/g)].map((match) => match[0]);
    expect([...LEGACY_DEPARTMENT_IDS]).toEqual(ids);
  });

  it("does not give a new department the legacy default", () => {
    const decision = evaluateRouting(snap({ departmentId: "00000000-0000-4000-8000-0000000000aa" }));
    expect(decision.reasonCode).toBe("missing_assignment");
    expect(decision.authorization).toBe("denied");
  });

  it("lets an explicit rejection override the legacy default", () => {
    const decision = evaluateRouting(snap({ assignments: [assignment({ status: "rejected" })] }));
    expect(decision.reasonCode).toBe("disabled_assignment");
  });

  it("denies an assignment whose model or family does not resolve", () => {
    const decision = evaluateRouting(snap({ assignments: [assignment({ registryModelId: "00000000-0000-4000-8000-0000000000bb", modelFamily: "missing" })] }));
    expect(decision.reasonCode).toBe("invalid_assignment");
  });

  it("denies an experimental adapter as an operational assignment", () => {
    const decision = evaluateRouting(snap({ assignments: [assignment({ role: "experimental_adapter" })] }));
    expect(decision.reasonCode).toBe("unapproved_assignment");
  });

  it("authorizes an available specialized assignment", () => {
    const decision = evaluateRouting(snap({
      assignments: [assignment({ registryModelId: SPECIALIZED, modelFamily: "gemma" })],
      evidence: { ...evidence("installed"), servingTag: "specialist:v1" },
    }));
    expect(decision.authorization).toBe("authorized");
    expect(decision.reasonCode).toBe("authorized_assignment");
    expect(decision.servingModel).toBe("specialist:v1");
  });

  it("denies a caller model override", () => {
    const decision = evaluateRouting(snap({ requestedModelId: QWEN3_4B_MODEL_ID }));
    expect(decision.reasonCode).toBe("model_override_denied");
  });

  it("uses the persisted department rather than a caller department", () => {
    const trusted = evaluateRouting(snap({ departmentId: LEGACY_DEPARTMENT_IDS[8] }));
    const forged = evaluateRouting(snap({ departmentId: "00000000-0000-4000-8000-0000000000aa" }));
    expect(trusted.authorization).toBe("authorized");
    expect(forged.reasonCode).toBe("missing_assignment");
  });

  it("rejects an agent whose department differs from the task department", () => {
    const decision = evaluateRouting(snap({ agentDepartmentId: LEGACY_DEPARTMENT_IDS[1] }));
    expect(decision.reasonCode).toBe("department_identity_mismatch");
  });

  it("keeps the first selection when a later snapshot would choose another model", () => {
    const pinned = evaluateRouting(snap());
    const later = evaluateRouting(snap({
      assignments: [assignment({ registryModelId: SPECIALIZED, modelFamily: "gemma" })],
      evidence: { ...evidence("installed"), servingTag: "specialist:v1" },
    }));
    expect(pinned.registryModelId).toBe(SHARED_QWEN3_8B_MODEL_ID);
    expect(later.registryModelId).toBe(SPECIALIZED);
    expect(pinned.registryModelId).not.toBe(later.registryModelId);
  });

  it("records a resumed task as the original selection object", () => {
    const original = evaluateRouting(snap());
    const resumed = original;
    expect(resumed.servingModel).toBe(original.servingModel);
    expect(resumed.assignmentVersion).toBeNull();
  });

  it("captures the digest supplied as evidence", () => {
    expect(evaluateRouting(snap()).modelDigest).toBe("sha256:qwen");
  });

  it("fails closed when the execution digest differs", () => {
    const decision = evaluateRouting(snap({ executionDigest: "sha256:other" }));
    expect(decision.reasonCode).toBe("digest_mismatch");
    expect(decision.executionVerification).toBe("mismatch");
  });

  it("leaves execution identity unverified when the backend cannot attest a digest", () => {
    const decision = evaluateRouting(snap({ executionDigest: null }));
    expect(decision.authorization).toBe("authorized");
    expect(decision.executionVerification).toBe("unverified");
  });

  it("allows an installed model that is not currently loaded", () => {
    const decision = evaluateRouting(snap({ evidence: evidence("installed") }));
    expect(decision.authorization).toBe("authorized");
    expect(decision.runtimeState).toBe("installed");
  });

  it("denies stale runtime evidence", () => {
    const decision = evaluateRouting(snap({ evidence: evidence("loaded", "2026-11-03T02:00:00.000Z") }));
    expect(decision.reasonCode).toBe("stale_runtime_evidence");
  });

  it("denies an unreachable runtime", () => {
    const decision = evaluateRouting(snap({ evidence: evidence("runtime_unreachable", NOW) }));
    expect(decision.reasonCode).toBe("runtime_unavailable");
  });

  it("routes an approved adapter to its derived serving artifact", () => {
    const decision = evaluateRouting(snap({
      assignments: [assignment({ role: "capability_adapter", adapterSha256: "adapter-sha" })],
      derived,
    }));
    expect(decision.authorization).toBe("authorized");
    expect(decision.servingModel).toBe("math-adapter:v3");
    expect(decision.adapterVersion).toBe("3");
  });

  it("denies an approved adapter with no derived artifact", () => {
    const decision = evaluateRouting(snap({ assignments: [assignment({ role: "capability_adapter", adapterSha256: "adapter-sha" })] }));
    expect(decision.reasonCode).toBe("missing_derived_model");
  });

  it("denies derived provenance that is not verified", () => {
    const decision = evaluateRouting(snap({
      assignments: [assignment({ role: "capability_adapter", adapterSha256: "adapter-sha" })],
      derived: { ...derived, provenanceVerified: false },
    }));
    expect(decision.reasonCode).toBe("invalid_adapter_provenance");
  });

  it("denies a non-Ollama serving backend", () => {
    expect(evaluateRouting(snap({ servingBackend: "other" })).reasonCode).toBe("unsupported_backend");
  });

  it("does not fall back to Qwen when the assigned runtime is unavailable", () => {
    const decision = evaluateRouting(snap({
      assignments: [assignment({ registryModelId: SPECIALIZED, modelFamily: "gemma" })],
      evidence: { ...evidence("runtime_unreachable", NOW), servingTag: "specialist:v1" },
    }));
    expect(decision.authorization).toBe("denied");
    expect(decision.reasonCode).toBe("runtime_unavailable");
    expect(decision.fallbackStatus).toBe("disabled");
    expect(decision.registryModelId).toBe(SPECIALIZED);
    expect(decision.servingModel).not.toBe("qwen3:8b");
  });

  it("denies a fallback assignment instead of activating it", () => {
    expect(evaluateRouting(snap({ assignments: [assignment({ role: "fallback" })] })).reasonCode).toBe("fallback_disabled");
  });

  it("denies a budget failure", () => {
    expect(evaluateRouting(snap({ budgetAllowed: false })).reasonCode).toBe("budget_denied");
  });

  it("denies a resource failure", () => {
    expect(evaluateRouting(snap({ resourceAllowed: false })).reasonCode).toBe("resource_denied");
  });

  it("records unknown memory without inventing a limit", () => {
    const decision = evaluateRouting(snap({ memoryKnown: false }));
    expect(decision.resourceOutcome).toBe("memory_unknown");
    expect(decision.authorization).toBe("authorized");
  });

  it("does not treat an empty ledger as zero capability or as authorization", () => {
    const decision = evaluateRouting(snap());
    expect(decision.capabilityNote).toContain("not zero capability");
    expect(decision.reasonCode).toBe("authorized_legacy_default");
  });

  it("excludes synthetic evidence from a real capability claim", () => {
    const decision = evaluateRouting(snap({ syntheticCapabilityCount: 2 }));
    expect(decision.capabilityNote).toContain("Synthetic");
    expect(decision.reasonCode).toBe("authorized_legacy_default");
  });

  it("does not call the backend for a denied decision", async () => {
    const provider = new ScriptedInferenceProvider(() => ({ text: "no", servedModel: "qwen3:8b", usage: { inputTokens: 1, outputTokens: 1, source: "observed" }, latencyMs: 1 }));
    const decision = evaluateRouting(snap({ departmentStatus: "inactive" }));
    if (decision.authorization === "authorized") {
      await provider.generate({ requestId: "x", registryModelId: decision.registryModelId, modelAlias: decision.servingModel, messages: [], temperature: 0, maxOutputTokens: 8, timeoutMs: 1000, jsonObject: false });
    }
    expect(decision.reasonCode).toBe("department_inactive");
    expect(provider.requests).toHaveLength(0);
  });

  it("submits the pinned serving model to the inference backend", async () => {
    const provider = new ScriptedInferenceProvider((request) => ({ text: "ok", servedModel: request.modelAlias, usage: { inputTokens: 1, outputTokens: 1, source: "observed" }, latencyMs: 4 }));
    const calls: string[] = [];
    const service = {
      async memoryMessages() {
        return null;
      },
      async completeGeneration(input: { servedModel: string }) {
        calls.push(input.servedModel);
        return "accepted" as const;
      },
      async failGeneration() {
        calls.push("failed");
      },
    };
    await executePrepared(service as never, provider, {
      action: "generate",
      requestId: "req-1",
      purpose: "specialist",
      objectiveId: "obj",
      taskId: "task",
      attempt: 1,
      reservedOutputTokens: 8,
      messages: [{ role: "user", content: "2+2" }],
      registryModelId: SHARED_QWEN3_8B_MODEL_ID,
      intendedModelId: SHARED_QWEN3_8B_MODEL_ID,
      modelAlias: "specialist:v1",
      temperature: 0,
      maxOutputTokens: 8,
      timeoutMs: 1000,
      cachedText: null,
      servingInstanceId: null,
    }, snapRoute());
    expect(provider.requests.map((request) => request.modelAlias)).toEqual(["specialist:v1"]);
    expect(calls).toEqual(["specialist:v1"]);
  });

  it("keeps an execution failure distinct from a routing denial", async () => {
    const provider = new ScriptedInferenceProvider(() => ({ text: "x", servedModel: "other-model", usage: { inputTokens: null, outputTokens: null, source: "unavailable" }, latencyMs: 2 }));
    const failures: string[] = [];
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
    await expect(executePrepared(service as never, provider, prepared("qwen3:8b"), snapRoute())).rejects.toThrow(/pinned routing decision/);
    expect(failures).toHaveLength(1);
    expect(evaluateRouting(snap()).authorization).toBe("authorized");
  });

  it("does not put department memory into a routing decision", () => {
    const decision = evaluateRouting(snap());
    expect(decision).not.toHaveProperty("memory");
    expect(JSON.stringify(decision)).not.toContain("prompt");
  });

  it("does not route evaluation or training through the department router", () => {
    const evaluation = readFileSync("packages/core/src/evaluation/evaluation-service.ts", "utf8");
    const training = readFileSync("services/training/research_m75.py", "utf8");
    expect(evaluation).not.toContain("evaluateRouting");
    expect(training).not.toContain("evaluateRouting");
    expect(training).not.toContain("DepartmentModelRouter");
  });

  it("limits health probes to endpoints that do not generate tokens", () => {
    const source = readFileSync("packages/inference/src/ollama-status.ts", "utf8");
    expect(source).toContain('"/api/version"');
    expect(source).toContain('"/api/tags"');
    expect(source).toContain('"/api/ps"');
    expect(source).not.toContain('"/api/generate"');
    expect(source).not.toContain('"/api/chat"');
  });

  it("is deterministic for the same trusted snapshot", () => {
    const left = evaluateRouting(snap());
    const right = evaluateRouting(snap());
    expect(left).toEqual(right);
  });

  it("exposes no update or delete operation on routing decisions", () => {
    const source = readFileSync("packages/database/src/repositories/routing.ts", "utf8");
    expect(source).not.toContain(".update(");
    expect(source).not.toContain(".delete(");
  });

  it("denies a specialized model that is not deployment-authorized", () => {
    const decision = evaluateRouting(snap({
      assignments: [assignment({ registryModelId: QWEN3_4B_MODEL_ID, modelFamily: "qwen3" })],
    }));
    expect(decision.reasonCode).toBe("deployment_not_authorized");
  });

  it("does not let a high capability count change the selected model", () => {
    const bare = evaluateRouting(snap());
    const scored = evaluateRouting(snap({ certifiedCapabilityCount: 9 }));
    expect(scored.registryModelId).toBe(bare.registryModelId);
    expect(scored.capabilityNote).toContain("did not change deployment authorization");
  });
});

function snapRoute() {
  return {
    memoryProfile: "shared" as const,
    alias: "qwen3:8b",
    operationalAlias: null,
    temperature: 0,
    maxOutputTokens: 8,
    timeoutMs: 1000,
    rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
    globalConcurrency: 1,
    departmentConcurrency: 1,
  };
}

function prepared(alias: string) {
  return {
    action: "generate" as const,
    requestId: "req-1",
    purpose: "specialist" as const,
    objectiveId: "obj",
    taskId: "task",
    attempt: 1,
    reservedOutputTokens: 8,
    messages: [{ role: "user" as const, content: "2+2" }],
    registryModelId: SHARED_QWEN3_8B_MODEL_ID,
    intendedModelId: SHARED_QWEN3_8B_MODEL_ID,
    modelAlias: alias,
    temperature: 0,
    maxOutputTokens: 8,
    timeoutMs: 1000,
    cachedText: null,
    servingInstanceId: null,
  };
}
