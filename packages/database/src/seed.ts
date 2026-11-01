import { randomUUID } from "node:crypto";
import {
  ROLE_NAMES,
  SPECIFICATION_VERSION,
  SYSTEM_ADMINISTRATOR_ID,
  resourceBudgetSchema,
} from "@ai-colony/contracts";
import {
  listRoleGrants,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  snapshot,
} from "@ai-colony/core";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  auditEvents,
  departments,
  models,
  permissions,
  principals,
  rolePermissions,
  roles,
} from "./schema/index.js";

export interface SeedResult {
  departmentsInserted: number;
  modelsInserted: number;
}

export const SEED_DEPARTMENT_BUDGET = resourceBudgetSchema.parse({
  maxConcurrentExecutions: 2,
  maxCpuAllocation: { value: 1000, unit: "millicores" },
  maxGpuAllocation: { value: 0, unit: "devices" },
  maxMemoryAllocation: { value: 2048, unit: "mebibytes" },
  maxEstimatedComputeExpenditure: { value: 0, unit: "usd_micros" },
  maxTrainingExpenditure: { value: 0, unit: "usd_micros" },
  maxModelParameterCount: { value: 0, unit: "parameters" },
  resetPeriod: null,
  expiresAt: null,
});

const INITIAL_DEPARTMENTS = [
  [
    "00000000-0000-4000-8000-000000000011",
    "CEO",
    "ceo",
    "Strategic planning, priorities, resource allocation, and organizational approval.",
    "Set colony priorities and approve organizational proposals that pass deterministic governance.",
  ],
  [
    "00000000-0000-4000-8000-000000000012",
    "Orchestration",
    "orchestration",
    "Task scheduling, coordination, execution, and department provisioning.",
    "Coordinate work across departments and provision approved organizational structures.",
  ],
  [
    "00000000-0000-4000-8000-000000000013",
    "Monitoring",
    "monitoring",
    "Resource usage, budgets, operational health, and anomaly detection.",
    "Observe budgets, health, and anomalies without authorizing changes.",
  ],
  [
    "00000000-0000-4000-8000-000000000014",
    "Evolution",
    "evolution",
    "Organizational restructuring, agent specialization, and proposals for new departments.",
    "Propose structural changes for later governed approval.",
  ],
  [
    "00000000-0000-4000-8000-000000000015",
    "Weight Optimization",
    "weight-optimization",
    "Neural-network training and model improvement.",
    "Own future training work. Milestone 1 stores the department only.",
  ],
  [
    "00000000-0000-4000-8000-000000000016",
    "Memory & Forgetting",
    "memory-and-forgetting",
    "Persistent knowledge, retention, consolidation, and deliberate forgetting.",
    "Own future memory policy. Milestone 1 stores the department only.",
  ],
  [
    "00000000-0000-4000-8000-000000000017",
    "Evaluation",
    "evaluation",
    "Testing, regression detection, promotion, and rollback.",
    "Own future evaluation and promotion gates.",
  ],
  [
    "00000000-0000-4000-8000-000000000018",
    "Research",
    "research",
    "Research into colony capabilities and external literature.",
    "Investigate questions that other departments can later adopt.",
  ],
  [
    "00000000-0000-4000-8000-000000000019",
    "Math",
    "math",
    "Mathematical problem solving and formal reasoning support.",
    "Provide mathematical work for the rest of the colony.",
  ],
  [
    "00000000-0000-4000-8000-00000000001a",
    "Reasoning",
    "reasoning",
    "General reasoning and problem decomposition.",
    "Break down problems that cross department boundaries.",
  ],
  [
    "00000000-0000-4000-8000-00000000001b",
    "Science",
    "science",
    "Scientific inquiry and experiment design support.",
    "Support scientific questions and experiment plans.",
  ],
  [
    "00000000-0000-4000-8000-00000000001c",
    "Gaming",
    "gaming",
    "Game-playing and interactive simulation tasks.",
    "Own future game and simulation benchmarks.",
  ],
] as const;

const INITIAL_MODELS = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    displayName: "Qwen3-8B",
    modelFamily: "qwen3",
    provider: "alibaba",
    parameterCount: 8_200_000_000,
    contextWindow: 32768,
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    displayName: "Qwen3-4B",
    modelFamily: "qwen3",
    provider: "alibaba",
    parameterCount: 4_000_000_000,
    contextWindow: 32768,
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    displayName: "Gemma 3 270M",
    modelFamily: "gemma-3",
    provider: "google",
    parameterCount: 270_000_000,
    contextWindow: 32768,
  },
] as const;

type SeedExecutor = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function seedFoundationsInTx(tx: SeedExecutor): Promise<void> {
  await tx
    .insert(permissions)
    .values(PERMISSIONS.map((name) => ({ name, description: PERMISSION_DESCRIPTIONS[name] })))
    .onConflictDoNothing();
  await tx
    .insert(roles)
    .values(ROLE_NAMES.map((name) => ({ name, description: ROLE_DESCRIPTIONS[name] })))
    .onConflictDoNothing();
  await tx.delete(rolePermissions);
  const grants = listRoleGrants();
  if (grants.length > 0) {
    await tx
      .insert(rolePermissions)
      .values(grants.map((grant) => ({ roleName: grant.role, permissionName: grant.permission })));
  }
  await tx
    .insert(principals)
    .values({
      id: SYSTEM_ADMINISTRATOR_ID,
      principalType: "system",
      displayName: "System Administrator",
      roleName: "system_administrator",
      agentId: null,
    })
    .onConflictDoUpdate({
      target: principals.id,
      set: {
        principalType: "system",
        displayName: "System Administrator",
        roleName: "system_administrator",
        agentId: null,
      },
    });
}

async function recordSeedAudit(
  tx: SeedExecutor,
  targetType: string,
  targetId: string,
  eventType: string,
  after: unknown,
): Promise<void> {
  await tx.insert(auditEvents).values({
    eventId: randomUUID(),
    eventType,
    actorId: SYSTEM_ADMINISTRATOR_ID,
    actorType: "system",
    targetType,
    targetId,
    action: "seed",
    correlationId: "seed",
    beforeState: null,
    afterState: snapshot(after),
    metadata: { source: "seed" },
  });
}

export async function seedFoundations(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await seedFoundationsInTx(tx);
  });
}

export async function seed(db: Database): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    await seedFoundationsInTx(tx);
    let departmentsInserted = 0;
    for (const [id, name, slug, description, purpose] of INITIAL_DEPARTMENTS) {
      const inserted = await tx
        .insert(departments)
        .values({
          id,
          name,
          slug,
          description,
          purpose,
          parentDepartmentId: null,
          status: "active",
          departmentType: "system",
          creationSource: "seed",
          createdBy: SYSTEM_ADMINISTRATOR_ID,
          resourceBudget: SEED_DEPARTMENT_BUDGET,
          policyRef: "rbac:seed-system",
          metadata: {},
          specificationVersion: SPECIFICATION_VERSION,
        })
        .onConflictDoNothing({ target: departments.slug })
        .returning();
      const row = inserted[0];
      if (row) {
        departmentsInserted += 1;
        await recordSeedAudit(tx, "department", row.id, "department.created", {
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          departmentType: row.departmentType,
          creationSource: row.creationSource,
        });
      }
    }

    let modelsInserted = 0;
    for (const model of INITIAL_MODELS) {
      const inserted = await tx
        .insert(models)
        .values({
          id: model.id,
          lineageId: model.id,
          version: 1,
          displayName: model.displayName,
          modelFamily: model.modelFamily,
          provider: model.provider,
          parameterCount: model.parameterCount,
          modelType: "causal-lm",
          artifactUri: null,
          deploymentTarget: "none",
          status: "not_deployed",
          quantization: null,
          contextWindow: model.contextWindow,
          capabilities: ["text-generation"],
          trainable: true,
        })
        .onConflictDoNothing({ target: models.id })
        .returning();
      const row = inserted[0];
      if (row) {
        modelsInserted += 1;
        await recordSeedAudit(tx, "model", row.id, "model.registered", {
          id: row.id,
          displayName: row.displayName,
          status: row.status,
          artifactUri: row.artifactUri,
          version: row.version,
        });
      }
    }

    return { departmentsInserted, modelsInserted };
  });
}

export async function truncateColony(db: Database): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      message_delivery_attempts,
      message_dead_letters,
      message_processing_records,
      message_outbox,
      messages,
      audit_events,
      agent_lifecycle_events,
      approval_requests,
      principals,
      agents,
      departments,
      models,
      role_permissions,
      roles,
      permissions
    RESTART IDENTITY CASCADE
  `);
}
