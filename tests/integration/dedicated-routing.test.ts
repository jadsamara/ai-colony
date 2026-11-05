import { SYSTEM_ADMINISTRATOR_ID } from "@ai-colony/contracts";
import {
  Authorizer,
  DEFAULT_MESSAGING_POLICY,
  MessagingService,
  ObjectiveService,
  bindDedicatedEndpoints,
  departmentProfiles,
  inventoryDepartmentStatus,
  planDedicatedInstances,
  type DepartmentSource,
  type InferenceRoute,
  type RequestContext,
} from "@ai-colony/core";
import { SEED_AGENTS, SEED_DEPARTMENTS, createPersistence, ensureDedicatedInventory, seed } from "@ai-colony/database";
import { ScriptedInferenceProvider } from "@ai-colony/inference";
import { compileCeoGraph, openCheckpointer, runCeoPass } from "@ai-colony/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../helpers/db.js";
import { TEST_DATABASE_URL } from "../helpers/env.js";

const departments: DepartmentSource[] = SEED_DEPARTMENTS.map(([id, name, slug, , purpose]) => ({
  id,
  name,
  slug,
  status: inventoryDepartmentStatus(slug),
  purpose,
}));
const profiles = departmentProfiles(
  departments,
  SEED_AGENTS.map(([id, departmentId]) => ({ id, departmentId })),
);

describe("dedicated objective routing", () => {
  const persistence = createPersistence(testDb(), async () => undefined);
  let checkpointer: Awaited<ReturnType<typeof openCheckpointer>>;

  beforeAll(async () => {
    checkpointer = await openCheckpointer(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await checkpointer.end();
  });

  it("records twelve serving instances once and leaves engineering inactive", async () => {
    await seed(testDb());
    const first = await ensureDedicatedInventory(testDb());
    const second = await ensureDedicatedInventory(testDb());
    expect(first.activeDepartments).toBe(12);
    expect(first.engineeringStatus).toBeNull();
    expect(first.instances).toHaveLength(13);
    expect(new Set(first.instances.map((instance) => instance.endpointReference)).size).toBe(13);
    expect(new Set(first.instances.map((instance) => instance.instanceId)).size).toBe(13);
    expect(first.instances.find((instance) => instance.endpointReference === "serving://product")).toMatchObject({
      status: "configured",
    });
    expect(first.instances.find((instance) => instance.endpointReference === "serving://gaming")).toMatchObject({
      status: "stopped",
    });
    expect(second.insertedInstances).toBe(0);
    expect(second.insertedAgents).toBe(0);
  });

  it("sends the production plan call to the CEO instance and not the shared provider", async () => {
    await seed(testDb());
    const planned = planDedicatedInstances(profiles, "ready");
    const bound = bindDedicatedEndpoints(planned, {
      resolve: (reference) => `http://${reference.slice("serving://".length)}.colony.test:9`,
    });
    const calls: string[] = [];
    const providers = new Map(bound.map((instance) => [
      instance.instanceId,
      new ScriptedInferenceProvider((request) => {
        calls.push(instance.instanceId);
        const system = request.messages[0]?.content ?? "";
        const text = system.includes("JSON object")
          ? JSON.stringify({
              summary: "One math task",
              tasks: [{
                localId: "math-load",
                departmentSlug: "math",
                taskType: "math",
                objective: "Add one and one",
                expectedOutput: "2",
                dependsOn: [],
              }],
              completionCriteria: ["A number is present"],
              estimatedResources: { inferenceRequests: 2, outputTokens: 100 },
              risks: ["none"],
            })
          : "done";
        return {
          text,
          servedModel: request.modelAlias,
          usage: { inputTokens: 1, outputTokens: 1, source: "observed" },
          latencyMs: 1,
        };
      }),
    ]));
    let sharedCalls = 0;
    const shared = new ScriptedInferenceProvider(() => {
      sharedCalls += 1;
      return {
        text: "shared",
        servedModel: "qwen3-8b",
        usage: { inputTokens: null, outputTokens: null, source: "unavailable" },
        latencyMs: 1,
      };
    });
    const route: InferenceRoute = {
      memoryProfile: "shared",
      alias: "qwen3-8b",
      operationalAlias: null,
      temperature: 0,
      maxOutputTokens: 256,
      timeoutMs: 1000,
      rates: { inputUsdPerMillion: null, outputUsdPerMillion: null },
      globalConcurrency: 1,
      departmentConcurrency: 1,
      dedicatedRouting: {
        enabled: true,
        instances: bound,
        providerFor: (instanceId) => providers.get(instanceId) ?? null,
      },
    };
    const messages = new MessagingService(persistence, new Authorizer(), DEFAULT_MESSAGING_POLICY);
    const objectives = new ObjectiveService(persistence, new Authorizer(), messages);
    const created = await objectives.submit(admin(), {
      objective: "State that this plan has no department tasks.",
    });
    const graph = compileCeoGraph({
      service: objectives,
      provider: shared,
      route,
      workerId: "ceo-dedicated",
      checkpointer,
    });
    await runCeoPass(graph, objectives);
    const scheduled = await objectives.get(admin(), created.id);
    expect(scheduled.status).toBe("scheduled");
    const ceo = bound.find((instance) => instance.endpointReference === "serving://ceo");
    expect(calls).toEqual([ceo?.instanceId]);
    expect(sharedCalls).toBe(0);
  });
});

function admin(): RequestContext {
  return {
    correlationId: "m12.1",
    actor: {
      principalId: SYSTEM_ADMINISTRATOR_ID,
      principalType: "system",
      role: "system_administrator",
      agentId: null,
      departmentId: null,
      permissions: [],
    },
  };
}
