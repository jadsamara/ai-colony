import { readFileSync } from "node:fs";
import { QWEN3_8B_MODEL_ID } from "@ai-colony/contracts";
import {
  bindDedicatedEndpoints,
  createDepartmentColony,
  departmentProfiles,
  estimateDedicatedCapacity,
  evaluateRouting,
  gcpDeploymentPlan,
  httpDepartmentClient,
  normalizeEndpoint,
  planDedicatedInstances,
  type DepartmentSource,
  type RoutingSnapshot,
} from "@ai-colony/core";
import { SEED_AGENTS, SEED_DEPARTMENTS } from "@ai-colony/database";
import { MockDepartmentServer } from "@ai-colony/inference";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const departments: DepartmentSource[] = SEED_DEPARTMENTS.map(([id, name, slug, , purpose]) => ({
  id,
  name,
  slug,
  status: "active",
  purpose,
}));
const agents = SEED_AGENTS.map(([id, departmentId]) => ({ id, departmentId }));
const profiles = departmentProfiles(departments, agents);

async function bootColony() {
  const planned = planDedicatedInstances(profiles, "ready");
  const servers = new Map<string, MockDepartmentServer>();
  for (const instance of planned) {
    const server = new MockDepartmentServer(instance.instanceId, instance.departmentId);
    await server.start();
    servers.set(instance.departmentId, server);
  }
  const bound = bindDedicatedEndpoints(planned, {
    resolve(reference) {
      const profile = profiles.find((candidate) => candidate.slug === reference.slice("serving://".length));
      if (!profile) {
        throw new Error(`unbound ${reference}`);
      }
      return servers.get(profile.departmentId)?.endpoint() ?? "";
    },
  });
  const colony = createDepartmentColony(profiles, bound, (instance) => httpDepartmentClient(instance));
  return { colony, servers, bound };
}

const started = await bootColony();

beforeAll(() => undefined);
afterAll(async () => {
  await Promise.all([...started.servers.values()].map((server) => server.stop()));
});

function snapshot(departmentId: string, patch: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  return {
    departmentId,
    departmentStatus: "active",
    agentDepartmentId: null,
    assignments: [],
    models: {
      [QWEN3_8B_MODEL_ID]: { id: QWEN3_8B_MODEL_ID, status: "not_deployed", modelFamily: "qwen3", displayName: "Qwen3 8B" },
    },
    requestedModelId: null,
    sharedServingTag: "qwen3:8b",
    derived: null,
    evidence: { state: "installed", capturedAt: "2026-11-04T00:00:00.000Z", digest: "sha256:qwen", servingTag: "qwen3:8b", artifactBytes: 5_200_000_000, loadedCount: 1 },
    now: "2026-11-04T00:00:10.000Z",
    budgetAllowed: true,
    resourceAllowed: true,
    memoryKnown: true,
    servingBackend: "ollama",
    certifiedCapabilityCount: 0,
    syntheticCapabilityCount: 0,
    executionDigest: null,
    dedicated: {
      instances: started.bound,
      requestedEndpoint: null,
      requestedInstanceId: null,
      pinnedInstanceId: null,
      pinnedModelVersion: null,
    },
    ...patch,
  };
}

describe("M12 independent department agents", () => {
  it("gives every active department its own agent, runtime, endpoint, and memory", async () => {
    expect(profiles).toHaveLength(12);
    expect(new Set(profiles.map((profile) => profile.agentId)).size).toBe(12);
    expect(new Set(started.bound.map((instance) => instance.instanceId)).size).toBe(12);
    expect(new Set(started.bound.map((instance) => instance.normalizedEndpoint)).size).toBe(12);
    expect(new Set(profiles.map((profile) => profile.memoryNamespace)).size).toBe(12);
    const runtimes = [...started.colony.runtimes.values()];
    expect(new Set(runtimes).size).toBe(12);
    const engineering = departmentProfiles(
      [...departments, { id: "00000000-0000-4000-8000-000000000099", slug: "engineering", name: "Engineering", status: "proposed", purpose: "Build software." }],
      agents,
    );
    expect(engineering.map((profile) => profile.slug)).not.toContain("engineering");
    for (const runtime of runtimes) {
      const status = await runtime.reportStatus();
      expect(status.servingInstanceId).toBe(started.bound.find((instance) => instance.departmentId === runtime.profile.departmentId)?.instanceId);
    }
  });

  it("rejects a shared serving instance and equivalent endpoint aliases", () => {
    const math = started.bound.find((instance) => instance.endpointReference === "serving://math")!;
    const science = started.bound.find((instance) => instance.endpointReference === "serving://science")!;
    expect(() => bindDedicatedEndpoints([math, { ...science, instanceId: math.instanceId }], {
      resolve: (reference) => reference === math.endpointReference ? math.normalizedEndpoint : science.normalizedEndpoint,
    })).toThrow(/already assigned/);
    const aliased = science.normalizedEndpoint.replace("127.0.0.1", "localhost");
    expect(normalizeEndpoint(aliased)).toBe(science.normalizedEndpoint);
    expect(() => bindDedicatedEndpoints([math, science], {
      resolve: () => aliased,
    })).toThrow(/already serves/);
  });

  it("rejects a math task that asks for science's endpoint", () => {
    const math = profiles.find((profile) => profile.slug === "math")!;
    const science = started.bound.find((instance) => instance.departmentId !== math.departmentId && instance.endpointReference === "serving://science")!;
    const decision = evaluateRouting(snapshot(math.departmentId, {
      dedicated: {
        instances: started.bound,
        requestedEndpoint: science.endpointReference,
        requestedInstanceId: null,
        pinnedInstanceId: null,
        pinnedModelVersion: null,
      },
    }));
    expect(decision.authorization).toBe("denied");
    expect(decision.reasonCode).toBe("endpoint_override_denied");
  });

  it("runs science, math, and reasoning through separate endpoints", async () => {
    const scienceServer = started.servers.get(profiles.find((profile) => profile.slug === "science")!.departmentId)!;
    const mathServer = started.servers.get(profiles.find((profile) => profile.slug === "math")!.departmentId)!;
    const reasoningServer = started.servers.get(profiles.find((profile) => profile.slug === "reasoning")!.departmentId)!;
    scienceServer.enqueue(JSON.stringify({ type: "collaborate", targetSlug: "math", objective: "check the load" }));
    scienceServer.enqueue(JSON.stringify({ type: "collaborate", targetSlug: "reasoning", objective: "review the argument" }));
    scienceServer.enqueue(JSON.stringify({ type: "final", text: "reviewed estimate" }));
    mathServer.enqueue(JSON.stringify({ type: "final", text: "load is illustrative" }));
    reasoningServer.enqueue(JSON.stringify({ type: "final", text: "argument holds" }));
    const science = started.colony.runtimeForSlug("science");
    await science.initialize();
    await science.acceptTask("00000000-0000-4000-8000-000000000901", "Compare solar and wind", "corr-m12", "orchestration");
    await science.executeTask("00000000-0000-4000-8000-000000000901");
    expect(science.task("00000000-0000-4000-8000-000000000901")?.result).toBe("reviewed estimate");
    expect(mathServer.requests).toHaveLength(1);
    expect(reasoningServer.requests).toHaveLength(1);
    expect(scienceServer.requests).toHaveLength(3);
    expect(started.colony.runtimeForSlug("orchestration").inbox.some((message) => message.payload.result === "reviewed estimate")).toBe(true);
    expect(JSON.stringify(mathServer.requests)).not.toContain(science.servingInstance.instanceId);
  });

  it("resumes a pinned task without repeating a tool call", async () => {
    const math = started.colony.runtimeForSlug("math");
    const server = started.servers.get(math.profile.departmentId)!;
    server.resetCounters();
    server.enqueue(JSON.stringify({ type: "tool", name: "calculate", input: "2+2" }));
    server.failAfter = 1;
    const taskId = "00000000-0000-4000-8000-000000000902";
    await math.acceptTask(taskId, "Add two and two", "corr-restart", null);
    await math.executeTask(taskId);
    expect(math.task(taskId)?.status).toBe("failed");
    expect(math.toolExecutions).toHaveLength(1);
    server.failAfter = null;
    server.enqueue(JSON.stringify({ type: "final", text: "4" }));
    await math.resume(taskId);
    expect(math.task(taskId)?.result).toBe("4");
    expect(math.task(taskId)?.servingInstanceId).toBe(math.servingInstance.instanceId);
    expect(math.toolExecutions).toHaveLength(1);
  });

  it("denies cross-department memory, tools, overrides, and unapproved movement", async () => {
    const math = started.colony.runtimeForSlug("math");
    const science = started.colony.runtimeForSlug("science");
    await expect(math.retrieveMemory({ departmentId: science.profile.departmentId, namespace: science.profile.memoryNamespace, query: "notes" })).rejects.toThrow(/memory namespace/);
    await expect(math.requestTool({ name: "simulate_turn", input: "go", idempotencyKey: "nope" })).rejects.toThrow(/not authorized/);
    const overridden = evaluateRouting(snapshot(math.profile.departmentId, { requestedModelId: "00000000-0000-4000-8000-000000000199" }));
    expect(overridden.reasonCode).toBe("model_override_denied");
    const pinned = started.bound.find((instance) => instance.departmentId === math.profile.departmentId)!;
    const migrated = evaluateRouting(snapshot(math.profile.departmentId, {
      dedicated: {
        instances: started.bound,
        requestedEndpoint: null,
        requestedInstanceId: null,
        pinnedInstanceId: pinned.instanceId,
        pinnedModelVersion: "qwen3-8b-science-v2",
      },
    }));
    expect(migrated.reasonCode).toBe("serving_migration_required");
  });

  it("fails math closed when its serving instance is down", async () => {
    const math = started.colony.runtimeForSlug("math");
    const science = started.colony.runtimeForSlug("science");
    const mathServer = started.servers.get(math.profile.departmentId)!;
    const scienceServer = started.servers.get(science.profile.departmentId)!;
    const before = scienceServer.requests.length;
    math.markUnavailable();
    mathServer.failing = true;
    const beforeDown = mathServer.requests.length;
    const taskId = "00000000-0000-4000-8000-000000000903";
    await math.acceptTask(taskId, "Differentiate x", "corr-down", null);
    await math.executeTask(taskId);
    expect(math.task(taskId)?.failureReason).toBe("SERVING_INSTANCE_UNAVAILABLE");
    expect(mathServer.requests).toHaveLength(beforeDown);
    scienceServer.enqueue(JSON.stringify({ type: "final", text: "still up" }));
    await science.acceptTask("00000000-0000-4000-8000-000000000904", "Name a gas", "corr-up", null);
    await science.executeTask("00000000-0000-4000-8000-000000000904");
    expect(science.task("00000000-0000-4000-8000-000000000904")?.result).toBe("still up");
    expect(scienceServer.requests.length).toBeGreaterThan(before);
    mathServer.failing = false;
  });

  it("keeps a pinned science version when the live instance is upgraded", async () => {
    const science = started.colony.runtimeForSlug("science");
    const server = started.servers.get(science.profile.departmentId)!;
    const previous = { ...science.servingInstance };
    const taskId = "00000000-0000-4000-8000-000000000905";
    server.enqueue(JSON.stringify({ type: "final", text: "version one" }));
    await science.acceptTask(taskId, "Old science task", "corr-version", null);
    await science.executeTask(taskId);
    expect(science.task(taskId)?.modelVersion).toBe("qwen3-8b-base-v1");
    science.replaceInstance({ ...science.servingInstance, modelVersion: "qwen3-8b-science-v2", status: "ready" });
    await expect(science.resume(taskId)).rejects.toThrow(/Pinned serving instance/);
    expect(science.task(taskId)?.modelVersion).toBe("qwen3-8b-base-v1");
    server.enqueue(JSON.stringify({ type: "final", text: "version two" }));
    await science.acceptTask("00000000-0000-4000-8000-000000000906", "New science task", "corr-version-2", null);
    await science.executeTask("00000000-0000-4000-8000-000000000906");
    expect(science.task("00000000-0000-4000-8000-000000000906")?.modelVersion).toBe("qwen3-8b-science-v2");
    expect(started.colony.runtimeForSlug("math").servingInstance.modelVersion).toBe(previous.modelVersion);
    science.replaceInstance(previous);
  });

  it("prepares a GCP plan without paid resources and labels capacity as an estimate", () => {
    const plan = gcpDeploymentPlan(started.bound);
    expect(plan.provisioned).toBe(false);
    expect(plan.enablePaidResources).toBe(false);
    expect(plan.kubernetes).toBe(false);
    expect(new Set(plan.services.map((service) => service.endpointReference)).size).toBe(12);
    const capacity = estimateDedicatedCapacity(12);
    expect(capacity.kind).toBe("estimate");
    expect(capacity.measuredLoadedInstances).toBe(0);
    expect(capacity.fitsOn24GbUnifiedMemory).toBe(false);
    expect(capacity.pooledAcrossGpus).toBe(false);
    const sql = readFileSync("packages/database/src/migrations/0012_dedicated_serving.sql", "utf8");
    expect(sql).toContain('CREATE TABLE "department_serving_instances"');
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.toLowerCase()).not.toContain("delete from");
    const terraform = readFileSync("infra/gcp/m12/main.tf", "utf8");
    expect(terraform).toContain("enable_paid_resources");
    expect(terraform).toContain("default     = false");
  });
});
