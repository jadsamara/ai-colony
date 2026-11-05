import {
  evaluateRouting,
  isLegacyDepartment,
  LEGACY_DEPARTMENT_IDS,
  LEGACY_ROUTING_POLICY_VERSION,
  SHARED_QWEN3_8B_MODEL_ID,
  type RoutingSnapshot,
} from "@ai-colony/core";
import { createReadOnlyInspection } from "./inspection.js";
import { migrationsFolder } from "./migrate.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTING_MIGRATION = { tag: "0011_routing_decisions", when: "1793553000000" };
const REQUIRED_INDEXES = ["routing_decisions_task_unique", "routing_decisions_objective_purpose_unique"];
const REQUIRED_CONSTRAINTS = [
  "routing_decisions_authorization_check",
  "routing_decisions_fallback_check",
  "routing_decisions_verification_check",
  "routing_decisions_task_fk",
  "routing_decisions_objective_fk",
  "routing_decisions_department_fk",
  "routing_decisions_assignment_fk",
  "routing_decisions_model_fk",
];
const REQUIRED_TRIGGERS = ["routing_decisions_no_update", "routing_decisions_no_delete"];

export interface RoutingDepartmentFinding {
  id: string;
  name: string;
  slug: string;
  status: string;
  legacy: boolean;
  authorization: "authorized" | "denied";
  reasonCode: string;
}

export interface RoutingReadiness {
  status: "ready" | "not_ready" | "unavailable";
  database: "connected" | "unavailable";
  readOnly: boolean;
  port: string | null;
  dataDirectory: string | null;
  policyVersion: typeof LEGACY_ROUTING_POLICY_VERSION;
  migration0011: "applied" | "pending";
  tablePresent: boolean;
  indexesPresent: string[];
  indexesMissing: string[];
  constraintsPresent: string[];
  constraintsMissing: string[];
  triggersPresent: string[];
  triggersMissing: string[];
  sharedModelRegistered: boolean;
  legacyAllowlistCount: number;
  activeDepartmentCount: number;
  activeDepartmentsDenied: string[];
  departments: RoutingDepartmentFinding[];
  liveInference: "not_run";
  detail: string;
}

export function routingSourceMigration(): { tag: string; when: string } {
  const journal = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const entry = journal.entries.find((item) => item.tag === ROUTING_MIGRATION.tag);
  if (!entry || String(entry.when) !== ROUTING_MIGRATION.when) {
    throw new Error("Migration 0011 is missing from the Drizzle journal");
  }
  return ROUTING_MIGRATION;
}

export async function assessRoutingReadiness(databaseUrl: string): Promise<RoutingReadiness> {
  routingSourceMigration();
  const inspection = createReadOnlyInspection(databaseUrl);
  try {
    await inspection.assertReadOnly();
    const directory = await inspection.sql<{ data_directory: string }[]>`SHOW data_directory`;
    const port = await inspection.sql<{ port: string }[]>`SHOW port`;
    const applied = await inspection.sql<{ created_at: string }[]>`
      SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
    `;
    const migration0011 = applied.some((row) => row.created_at === ROUTING_MIGRATION.when) ? "applied" : "pending";
    const table = await inspection.sql<{ name: string | null }[]>`SELECT to_regclass('public.routing_decisions')::text AS name`;
    const tablePresent = table[0]?.name === "routing_decisions";
    const indexes = tablePresent
      ? await inspection.sql<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'routing_decisions'
        `
      : [];
    const constraints = tablePresent
      ? await inspection.sql<{ conname: string }[]>`
          SELECT conname FROM pg_constraint WHERE conrelid = 'public.routing_decisions'::regclass
        `
      : [];
    const triggers = tablePresent
      ? await inspection.sql<{ tgname: string }[]>`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'public.routing_decisions'::regclass AND NOT tgisinternal
        `
      : [];
    const indexNames = new Set(indexes.map((row) => row.indexname));
    const constraintNames = new Set(constraints.map((row) => row.conname));
    const triggerNames = new Set(triggers.map((row) => row.tgname));
    const models = await inspection.sql<{ id: string; status: string; model_family: string; display_name: string }[]>`
      SELECT id::text, status, model_family, display_name FROM models
    `;
    const departments = await inspection.sql<{ id: string; name: string; slug: string; status: string }[]>`
      SELECT id::text, name, slug, status FROM departments ORDER BY id
    `;
    const assignments = await inspection.sql<{
      id: string;
      department_id: string;
      role: "shared_base" | "experimental_adapter" | "capability_adapter" | "fallback";
      registry_model_id: string;
      adapter_sha256: string | null;
      model_family: string;
      version: number;
      status: "active" | "superseded" | "rejected";
    }[]>`
      SELECT id::text, department_id::text, role, registry_model_id::text, adapter_sha256, model_family, version, status
      FROM department_model_assignments
    `;
    const modelMap = Object.fromEntries(models.map((model) => [model.id, {
      id: model.id,
      status: model.status,
      modelFamily: model.model_family,
      displayName: model.display_name,
    }]));
    const findings = departments.map((department) => {
      const departmentAssignments = assignments
        .filter((row) => row.department_id === department.id)
        .map((row) => ({
          id: row.id,
          departmentId: row.department_id,
          role: row.role,
          registryModelId: row.registry_model_id,
          adapterSha256: row.adapter_sha256,
          modelFamily: row.model_family,
          version: row.version,
          status: row.status,
        }));
      const decision = evaluateRouting(snapshotFor(department, departmentAssignments, modelMap));
      return {
        id: department.id,
        name: department.name,
        slug: department.slug,
        status: department.status,
        legacy: isLegacyDepartment(department.id),
        authorization: decision.authorization,
        reasonCode: decision.reasonCode,
      };
    });
    const activeDenied = findings.filter((finding) => finding.status === "active" && finding.authorization !== "authorized");
    const schemaReady = migration0011 === "applied"
      && tablePresent
      && REQUIRED_INDEXES.every((name) => indexNames.has(name))
      && REQUIRED_CONSTRAINTS.every((name) => constraintNames.has(name))
      && REQUIRED_TRIGGERS.every((name) => triggerNames.has(name))
      && models.some((model) => model.id === SHARED_QWEN3_8B_MODEL_ID);
    const status = schemaReady && activeDenied.length === 0 ? "ready" : "not_ready";
    return {
      status,
      database: "connected",
      readOnly: true,
      port: port[0]?.port ?? null,
      dataDirectory: directory[0]?.data_directory ?? null,
      policyVersion: LEGACY_ROUTING_POLICY_VERSION,
      migration0011,
      tablePresent,
      indexesPresent: REQUIRED_INDEXES.filter((name) => indexNames.has(name)),
      indexesMissing: REQUIRED_INDEXES.filter((name) => !indexNames.has(name)),
      constraintsPresent: REQUIRED_CONSTRAINTS.filter((name) => constraintNames.has(name)),
      constraintsMissing: REQUIRED_CONSTRAINTS.filter((name) => !constraintNames.has(name)),
      triggersPresent: REQUIRED_TRIGGERS.filter((name) => triggerNames.has(name)),
      triggersMissing: REQUIRED_TRIGGERS.filter((name) => !triggerNames.has(name)),
      sharedModelRegistered: models.some((model) => model.id === SHARED_QWEN3_8B_MODEL_ID),
      legacyAllowlistCount: LEGACY_DEPARTMENT_IDS.length,
      activeDepartmentCount: findings.filter((finding) => finding.status === "active").length,
      activeDepartmentsDenied: activeDenied.map((finding) => finding.slug),
      departments: findings,
      liveInference: "not_run",
      detail: status === "ready"
        ? "Routing schema and the legacy department policy are present. This is not live inference readiness."
        : "Routing infrastructure is not ready. A migration file in source code is not a deployment.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Routing readiness failed";
    return unavailable(message);
  } finally {
    await inspection.close();
  }
}

function snapshotFor(
  department: { id: string; status: string },
  assignments: RoutingSnapshot["assignments"],
  models: RoutingSnapshot["models"],
): RoutingSnapshot {
  return {
    departmentId: department.id,
    departmentStatus: department.status,
    agentDepartmentId: null,
    assignments,
    models,
    requestedModelId: null,
    sharedServingTag: "qwen3:8b",
    derived: null,
    evidence: {
      state: "readiness_unknown",
      capturedAt: null,
      digest: null,
      servingTag: null,
      artifactBytes: null,
      loadedCount: null,
    },
    now: "2026-11-03T04:00:00.000Z",
    budgetAllowed: true,
    resourceAllowed: true,
    memoryKnown: false,
    servingBackend: "ollama",
    certifiedCapabilityCount: 0,
    syntheticCapabilityCount: 0,
    executionDigest: null,
  };
}

function unavailable(detail: string): RoutingReadiness {
  return {
    status: "unavailable",
    database: "unavailable",
    readOnly: false,
    port: null,
    dataDirectory: null,
    policyVersion: LEGACY_ROUTING_POLICY_VERSION,
    migration0011: "pending",
    tablePresent: false,
    indexesPresent: [],
    indexesMissing: [...REQUIRED_INDEXES],
    constraintsPresent: [],
    constraintsMissing: [...REQUIRED_CONSTRAINTS],
    triggersPresent: [],
    triggersMissing: [...REQUIRED_TRIGGERS],
    sharedModelRegistered: false,
    legacyAllowlistCount: LEGACY_DEPARTMENT_IDS.length,
    activeDepartmentCount: 0,
    activeDepartmentsDenied: [],
    departments: [],
    liveInference: "not_run",
    detail,
  };
}
