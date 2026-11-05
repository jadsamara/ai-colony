import { randomUUID } from "node:crypto";
import {
  SPECIFICATION_VERSION,
  SYSTEM_ADMINISTRATOR_ID,
  parameterBudgetSchema,
  resourceBudgetSchema,
} from "@ai-colony/contracts";
import { departmentProfiles, planDedicatedInstances, snapshot, type DedicatedServingInstance } from "@ai-colony/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { SEED_AGENTS, SEED_DEPARTMENT_BUDGET } from "./seed.js";
import { agents, auditEvents, departmentServingEvents, departmentServingInstances, departments, principals } from "./schema/index.js";

export interface ServingInventoryResult {
  activeDepartments: number;
  insertedAgents: number;
  insertedInstances: number;
  instances: DedicatedServingInstance[];
  engineeringStatus: string | null;
}

export async function ensureDedicatedInventory(db: Database): Promise<ServingInventoryResult> {
  return db.transaction(async (tx) => {
    const departmentRows = await tx.select().from(departments);
    const engineering = departmentRows.find((row) => row.slug === "engineering");
    if (engineering?.status === "active") {
      throw new Error("Engineering is active. Dedicated inventory will not run.");
    }
    const active = departmentRows.filter((row) => row.status === "active");
    const agentRows = await tx.select().from(agents);
    let insertedAgents = 0;
    for (const department of active) {
      const existing = agentRows.find((agent) => agent.departmentId === department.id);
      if (existing) {
        continue;
      }
      const seed = SEED_AGENTS.find((row) => row[1] === department.id);
      if (!seed) {
        throw new Error(`Active department ${department.slug} has no agent and no seed identity`);
      }
      const [id, departmentId, name, role, namespace, modelId, description] = seed;
      await tx.insert(agents).values({
        id,
        departmentId,
        name,
        roleName: role,
        description,
        capabilities: ["text-generation"],
        modelId,
        adapterVersion: null,
        memoryNamespace: namespace,
        computeBudget: resourceBudgetSchema.parse({ ...SEED_DEPARTMENT_BUDGET, maxConcurrentExecutions: 1 }),
        parameterBudget: parameterBudgetSchema.parse({ maxModelParameterCount: { value: 0, unit: "parameters" } }),
        status: "idle",
        performanceMetrics: {},
        parentAgentId: null,
        specificationVersion: SPECIFICATION_VERSION,
      });
      await tx.insert(principals).values({
        id,
        principalType: "agent",
        displayName: name,
        roleName: role,
        agentId: id,
      }).onConflictDoNothing();
      await tx.insert(auditEvents).values({
        eventId: randomUUID(),
        eventType: "agent.created",
        actorId: SYSTEM_ADMINISTRATOR_ID,
        actorType: "system",
        targetType: "agent",
        targetId: id,
        action: "seed",
        correlationId: "m12.1-inventory",
        beforeState: null,
        afterState: snapshot({ id, name, role }),
        metadata: { source: "m12.1-inventory" },
      });
      insertedAgents += 1;
    }
    const refreshedAgents = await tx.select().from(agents);
    const profiles = departmentProfiles(
      active.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        purpose: row.purpose,
      })),
      refreshedAgents.map((row) => ({ id: row.id, departmentId: row.departmentId })),
    );
    const planned = planDedicatedInstances(profiles);
    let insertedInstances = 0;
    for (const instance of planned) {
      const inserted = await tx
        .insert(departmentServingInstances)
        .values({
          id: instance.instanceId,
          departmentId: instance.departmentId,
          agentId: instance.agentId,
          provider: instance.provider,
          endpointReference: instance.endpointReference,
          normalizedEndpoint: instance.normalizedEndpoint,
          modelRegistryId: instance.modelRegistryId,
          modelVersion: instance.modelVersion,
          artifactDigest: instance.artifactDigest,
          deploymentMode: instance.deploymentMode,
          status: "configured",
          resourcePolicyId: instance.resourcePolicyId,
        })
        .onConflictDoNothing({ target: departmentServingInstances.departmentId })
        .returning();
      const row = inserted[0];
      if (!row) {
        continue;
      }
      insertedInstances += 1;
      await tx.insert(departmentServingEvents).values({
        id: randomUUID(),
        instanceId: row.id,
        fromStatus: "configured",
        toStatus: "configured",
        actorId: SYSTEM_ADMINISTRATOR_ID,
        reason: "Record a dedicated serving instance. This does not mark it ready and does not start a model.",
      });
    }
    const stored = await tx.select().from(departmentServingInstances);
    return {
      activeDepartments: active.length,
      insertedAgents,
      insertedInstances,
      instances: stored.map((row) => ({
        instanceId: row.id,
        departmentId: row.departmentId,
        agentId: row.agentId,
        provider: row.provider as DedicatedServingInstance["provider"],
        endpointReference: row.endpointReference,
        normalizedEndpoint: row.normalizedEndpoint,
        modelRegistryId: row.modelRegistryId,
        modelVersion: row.modelVersion,
        artifactDigest: row.artifactDigest,
        deploymentMode: "dedicated",
        status: row.status as DedicatedServingInstance["status"],
        resourcePolicyId: row.resourcePolicyId,
      })),
      engineeringStatus: engineering?.status ?? null,
    };
  });
}

export async function listDedicatedInstances(db: Database): Promise<DedicatedServingInstance[]> {
  const rows = await db.select().from(departmentServingInstances);
  return rows.map((row) => ({
    instanceId: row.id,
    departmentId: row.departmentId,
    agentId: row.agentId,
    provider: row.provider as DedicatedServingInstance["provider"],
    endpointReference: row.endpointReference,
    normalizedEndpoint: row.normalizedEndpoint,
    modelRegistryId: row.modelRegistryId,
    modelVersion: row.modelVersion,
    artifactDigest: row.artifactDigest,
    deploymentMode: "dedicated",
    status: row.status as DedicatedServingInstance["status"],
    resourcePolicyId: row.resourcePolicyId,
  }));
}

export async function recordServingStatus(
  db: Database,
  instanceId: string,
  status: DedicatedServingInstance["status"],
  reason: string,
): Promise<void> {
  const [current] = await db
    .select()
    .from(departmentServingInstances)
    .where(eq(departmentServingInstances.id, instanceId))
    .limit(1);
  if (!current || current.status === status) {
    return;
  }
  await db
    .update(departmentServingInstances)
    .set({ status, updatedAt: new Date() })
    .where(eq(departmentServingInstances.id, instanceId));
  await db.insert(departmentServingEvents).values({
    id: randomUUID(),
    instanceId,
    fromStatus: current.status,
    toStatus: status,
    actorId: SYSTEM_ADMINISTRATOR_ID,
    reason,
  });
}
