import { randomUUID } from "node:crypto";
import {
  ROLE_NAMES,
  SPECIFICATION_VERSION,
  SYSTEM_ADMINISTRATOR_ID,
  parameterBudgetSchema,
  resourceBudgetSchema,
} from "@ai-colony/contracts";
import {
  PRODUCT_DEPARTMENT_ID,
  departmentProfiles,
  listRoleGrants,
  PERMISSION_DESCRIPTIONS,
  PERMISSIONS,
  planDedicatedInstances,
  ROLE_DESCRIPTIONS,
  snapshot,
} from "@ai-colony/core";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { installProductDepartment } from "./product-install.js";
import {
  agents,
  auditEvents,
  departmentServingEvents,
  departmentServingInstances,
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
  agentsInserted: number;
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
    "Propose training experiments and candidate reviews. Approval and promotion stay outside the department.",
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
  [
    "00000000-0000-4000-8000-00000000001d",
    "Product",
    "product",
    "Continuous improvement of the colony as a system.",
    "Identify gaps, propose measured improvements, and track outcomes. Cannot approve its own proposals or create departments.",
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

const FOUNDING_AGENTS = [
  ["00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000011", "CEO", "ceo_agent", "seed.ceo", "00000000-0000-4000-8000-000000000101", "Plans objectives. Does not grant permissions."],
  ["00000000-0000-4000-8000-000000000208", "00000000-0000-4000-8000-000000000015", "Weight Optimization", "department_agent", "seed.weight-optimization", "00000000-0000-4000-8000-000000000103", "Proposes training experiments. Cannot approve a budget, promote a candidate, or replace production Qwen."],
  ["00000000-0000-4000-8000-000000000209", "00000000-0000-4000-8000-000000000017", "Evaluation", "department_agent", "seed.evaluation", "00000000-0000-4000-8000-000000000103", "Proposes benchmark runs. Cannot approve a suite, decide a gate, or change production routing."],
  ["00000000-0000-4000-8000-000000000210", "00000000-0000-4000-8000-000000000016", "Memory & Forgetting", "department_agent", "seed.memory-and-forgetting", "00000000-0000-4000-8000-000000000101", "Reviews experience and proposes retention. Cannot approve forgetting or erase weights."],
  ["00000000-0000-4000-8000-000000000202", "00000000-0000-4000-8000-000000000012", "Orchestration", "orchestration_agent", "seed.orchestration", "00000000-0000-4000-8000-000000000102", "Schedules approved tasks."],
  ["00000000-0000-4000-8000-000000000203", "00000000-0000-4000-8000-000000000013", "Monitoring", "monitoring_agent", "seed.monitoring", "00000000-0000-4000-8000-000000000102", "Observes execution and publishes health alerts."],
  ["00000000-0000-4000-8000-000000000204", "00000000-0000-4000-8000-000000000019", "Math", "department_agent", "seed.math", "00000000-0000-4000-8000-000000000101", "Completes quantitative tasks."],
  ["00000000-0000-4000-8000-000000000205", "00000000-0000-4000-8000-00000000001b", "Science", "department_agent", "seed.science", "00000000-0000-4000-8000-000000000101", "Completes scientific analysis tasks."],
  ["00000000-0000-4000-8000-000000000206", "00000000-0000-4000-8000-000000000018", "Research", "department_agent", "seed.research", "00000000-0000-4000-8000-000000000101", "Completes evidence tasks without external tools."],
  ["00000000-0000-4000-8000-000000000207", "00000000-0000-4000-8000-00000000001a", "Reasoning", "department_agent", "seed.reasoning", "00000000-0000-4000-8000-000000000101", "Completes reasoning tasks."],
  ["00000000-0000-4000-8000-000000000211", "00000000-0000-4000-8000-000000000014", "Evolution", "evolution_agent", "seed.evolution", "00000000-0000-4000-8000-000000000101", "Proposes structural changes. Cannot create or activate a department."],
  ["00000000-0000-4000-8000-000000000212", "00000000-0000-4000-8000-00000000001c", "Gaming", "department_agent", "seed.gaming", "00000000-0000-4000-8000-000000000101", "Owns game and simulation tasks. Cannot reach outside the task state."],
  ["00000000-0000-4000-8000-000000000213", "00000000-0000-4000-8000-00000000001d", "Product", "department_agent", "seed.product", "00000000-0000-4000-8000-000000000101", "Proposes colony improvements. Cannot approve them, create a department, promote weights, or deploy infrastructure."],
] as const;

export const SEED_DEPARTMENTS = INITIAL_DEPARTMENTS;
export const SEED_AGENTS = FOUNDING_AGENTS;

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
      if (slug === "product") {
        continue;
      }
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

    const agentBudget = resourceBudgetSchema.parse({
      ...SEED_DEPARTMENT_BUDGET,
      maxConcurrentExecutions: 1,
    });
    const parameterBudget = parameterBudgetSchema.parse({
      maxModelParameterCount: { value: 0, unit: "parameters" },
    });
    let agentsInserted = 0;
    for (const [id, departmentId, name, role, namespace, modelId, description] of FOUNDING_AGENTS) {
      if (departmentId === PRODUCT_DEPARTMENT_ID) {
        continue;
      }
      const inserted = await tx
        .insert(agents)
        .values({
          id,
          departmentId,
          name,
          roleName: role,
          description,
          capabilities: ["text-generation"],
          modelId,
          adapterVersion: null,
          memoryNamespace: namespace,
          computeBudget: agentBudget,
          parameterBudget,
          status: "idle",
          performanceMetrics: {},
          parentAgentId: null,
          specificationVersion: SPECIFICATION_VERSION,
        })
        .onConflictDoNothing({ target: agents.id })
        .returning();
      const row = inserted[0];
      if (!row) {
        continue;
      }
      agentsInserted += 1;
      await tx
        .insert(principals)
        .values({
          id,
          principalType: "agent",
          displayName: name,
          roleName: role,
          agentId: id,
        })
        .onConflictDoNothing();
      await recordSeedAudit(tx, "agent", row.id, "agent.created", {
        id: row.id,
        name: row.name,
        status: row.status,
        role: row.roleName,
      });
    }

    const departmentRows = await tx.select().from(departments);
    const agentRows = await tx.select().from(agents);
    const profiles = departmentProfiles(
      departmentRows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        purpose: row.purpose,
      })),
      agentRows.map((row) => ({ id: row.id, departmentId: row.departmentId })),
    );
    for (const instance of planDedicatedInstances(profiles)) {
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
          status: instance.status,
          resourcePolicyId: instance.resourcePolicyId,
        })
        .onConflictDoNothing({ target: departmentServingInstances.id })
        .returning();
      const row = inserted[0];
      if (!row) {
        continue;
      }
      await tx.insert(departmentServingEvents).values({
        id: randomUUID(),
        instanceId: row.id,
        fromStatus: "configured",
        toStatus: "configured",
        actorId: SYSTEM_ADMINISTRATOR_ID,
        reason: "Seed a dedicated serving instance. This does not start a model.",
      });
    }

    const installed = await installProductDepartment(tx);
    return {
      departmentsInserted: departmentsInserted + installed.departmentsInserted,
      modelsInserted,
      agentsInserted: agentsInserted + installed.agentsInserted,
    };
  });
}

export async function truncateColony(db: Database): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      training_experiments,
      deployment_decisions,
      improvement_decisions,
      memory_ownership,
      collaboration_entries,
      collaboration_participants,
      collaboration_contexts,
      learning_outcomes,
      learning_budgets,
      learning_cycle_events,
      knowledge_validations,
      knowledge_transfers,
      learning_cycles,
      learning_objectives,
      capability_gaps,
      department_model_assignments,
      department_capability_versions,
      department_capabilities,
      artifact_contamination,
      lineage_edges,
      forgetting_requests,
      retention_policies,
      rollback_requests,
      experimental_route_versions,
      experimental_routes,
      candidate_gate_decisions,
      evaluation_item_results,
      evaluation_reports,
      evaluation_runs,
      benchmark_items,
      benchmark_versions,
      benchmark_suites,
      model_version_events,
      model_promotion_requests,
      candidate_evaluations,
      model_candidates,
      model_adapters,
      training_artifacts,
      training_run_metrics,
      training_runs,
      training_examples,
      training_dataset_versions,
      training_datasets,
      trainable_models,
      memory_retrieval_hits,
      memory_retrieval_events,
      memory_contradictions,
      memory_consolidation_records,
      memory_promotion_requests,
      memory_revisions,
      memory_sources,
      memory_embeddings,
      memory_embedding_usage,
      memories,
      inference_usage,
      inference_requests,
      product_improvement_events,
      product_improvement_proposals,
      department_agent_checkpoints,
      department_serving_events,
      department_serving_instances,
      routing_decisions,
      task_results,
      task_assignments,
      objective_tasks,
      objective_plans,
      workflow_events,
      worker_heartbeats,
      objective_runs,
      model_runtimes,
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
