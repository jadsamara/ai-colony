import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CEO_DEPARTMENT_ID,
  assertDedicatedCapacity,
  bindDedicatedEndpoints,
  composeStopInvocation,
  departmentProfiles,
  estimateDedicatedCapacity,
  gateDedicatedExecution,
  limitsFromEnv,
  planDedicatedInstances,
  planModelArtifacts,
  renderDedicatedCompose,
  resolveDedicatedProvider,
  writeActivationAtomic,
  readActivation,
  type DepartmentSource,
  type RoutingSelection,
} from "@ai-colony/core";
import { SEED_AGENTS, SEED_DEPARTMENTS, assertAdditiveMigration } from "@ai-colony/database";
import { describe, expect, it } from "vitest";

const departments: DepartmentSource[] = SEED_DEPARTMENTS.map(([id, name, slug, , purpose]) => ({
  id,
  name,
  slug,
  status: "active",
  purpose,
}));
const profiles = departmentProfiles(
  departments,
  SEED_AGENTS.map(([id, departmentId]) => ({ id, departmentId })),
);
const instances = planDedicatedInstances(profiles, "ready");

function selection(instanceId: string): RoutingSelection {
  return {
    authorization: "authorized",
    reasonCode: "authorized_legacy_default",
    departmentId: CEO_DEPARTMENT_ID,
    assignmentId: null,
    assignmentVersion: null,
    registryModelId: "00000000-0000-4000-8000-000000000101",
    servingModel: "qwen3:8b",
    modelDigest: null,
    adapterId: null,
    adapterVersion: null,
    policyVersion: "m10-legacy-shared-qwen3-8b-v1",
    fallbackStatus: "disabled",
    budgetOutcome: "allowed",
    resourceOutcome: "allowed",
    executionVerification: "unverified",
    capabilityNote: "test",
    runtimeState: "readiness_unknown",
    evidenceCapturedAt: null,
    servingInstanceId: instanceId,
    endpointReference: "serving://ceo",
    agentId: "00000000-0000-4000-8000-000000000201",
    servingPolicyVersion: "m12-dedicated-serving-v1",
  };
}

describe("M12.1 dedicated activation", () => {
  it("renders twelve private agent and model services", () => {
    const real = renderDedicatedCompose({ mode: "real", profiles, instances });
    const mock = renderDedicatedCompose({ mode: "mock", profiles, instances });
    expect(real.services.filter((name) => name.startsWith("ollama-"))).toHaveLength(12);
    expect(real.services.filter((name) => name.startsWith("agent-"))).toHaveLength(12);
    expect(mock.services.filter((name) => name.startsWith("mock-"))).toHaveLength(12);
    expect(new Set(real.services).size).toBe(24);
    expect(real.yaml).not.toContain("nvidia");
    expect(real.yaml).not.toContain("\"11434:");
    expect(real.yaml).not.toContain("engineering");
    expect(real.yaml).toContain("ollama/ollama:0.9.6");
    expect(mock.yaml).toContain("COLONY_MODE: mock");
    expect(mock.yaml).not.toContain("ollama/ollama");
    expect(composeStopInvocation(real.fileName).join(" ")).not.toContain("-v");
  });

  it("rejects a shared endpoint and a 24 GB real deployment", () => {
    const [math, science] = instances;
    expect(math && science).toBeTruthy();
    expect(() => bindDedicatedEndpoints([math!, { ...science!, normalizedEndpoint: "http://127.0.0.1:9/v1" }], {
      resolve: () => "http://127.0.0.1:9/v1",
    })).toThrow(/Endpoint already serves/);
    const estimate = estimateDedicatedCapacity(12);
    const refused = assertDedicatedCapacity(estimate, limitsFromEnv({ COLONY_HOST_RAM_BYTES: String(24 * 1024 ** 3) }, null), "real");
    expect(refused.ok).toBe(false);
    expect(assertDedicatedCapacity(estimate, limitsFromEnv({}, null), "mock").ok).toBe(true);
  });

  it("fails closed on missing, mismatched, and unpinned artifacts", () => {
    const real = planModelArtifacts({
      instances,
      observations: instances.map((instance) => ({ instanceId: instance.instanceId, recordedDigest: null, measuredBytes: null })),
      expectedDigests: {},
      mode: "real",
      allowDownload: false,
    });
    expect(real.ok).toBe(false);
    const mismatched = planModelArtifacts({
      instances: [instances[0]!],
      observations: [{ instanceId: instances[0]!.instanceId, recordedDigest: "sha256:other", measuredBytes: null }],
      expectedDigests: { [instances[0]!.modelVersion]: "sha256:approved" },
      mode: "real",
      allowDownload: true,
    });
    expect(mismatched.plans[0]?.action).toBe("mismatch");
    expect(mismatched.ok).toBe(false);
    expect(planModelArtifacts({
      instances,
      observations: [],
      expectedDigests: {},
      mode: "mock",
      allowDownload: false,
    }).ok).toBe(true);
  });

  it("keeps a pinned model version and does not call the shared provider", async () => {
    const ceo = instances.find((instance) => instance.departmentId === CEO_DEPARTMENT_ID);
    expect(ceo).toBeTruthy();
    const pinned = selection(ceo!.instanceId);
    expect(gateDedicatedExecution(pinned, instances, "qwen3-8b-base-v1").ok).toBe(true);
    expect(gateDedicatedExecution(pinned, [{ ...ceo!, modelVersion: "qwen3-8b-science-v2" }], "qwen3-8b-base-v1")).toMatchObject({
      ok: false,
      reason: "serving_migration_required",
    });
    expect(gateDedicatedExecution(pinned, [{ ...ceo!, status: "unavailable" }], "qwen3-8b-base-v1")).toMatchObject({
      ok: false,
      reason: "serving_instance_unavailable",
    });
    let sharedCalled = false;
    const shared = {
      async generate() {
        sharedCalled = true;
        return { text: "shared", servedModel: "qwen3:8b", usage: { inputTokens: null, outputTokens: null, source: "unavailable" as const }, latencyMs: 1 };
      },
      async probe() {
        return { reachable: true, modelIds: [], error: null };
      },
    };
    expect(() => resolveDedicatedProvider(shared, ceo!.instanceId, {
      enabled: true,
      instances,
      providerFor: () => null,
    })).toThrow(/shared inference route/);
    expect(sharedCalled).toBe(false);
  });

  it("writes the activation switch atomically and accepts only additive SQL", () => {
    const directory = mkdtempSync(join(tmpdir(), "colony-activation-"));
    const file = join(directory, "nested/dedicated-routing.json");
    writeActivationAtomic(file, {
      enabled: true,
      policyVersion: "m12-dedicated-serving-v1",
      activatedAt: "2026-11-04T00:00:00.000Z",
      instanceIds: ["one"],
      mode: "mock",
    });
    expect(readActivation(file)?.enabled).toBe(true);
    writeActivationAtomic(file, {
      enabled: false,
      policyVersion: "m12-dedicated-serving-v1",
      activatedAt: null,
      instanceIds: [],
      mode: "real",
    });
    expect(readActivation(file)?.enabled).toBe(false);
    const sql = readFileSync("packages/database/src/migrations/0012_dedicated_serving.sql", "utf8");
    expect(() => assertAdditiveMigration(sql)).not.toThrow();
    expect(() => assertAdditiveMigration("DROP TABLE routing_decisions")).toThrow(/not additive/);
  });
});
