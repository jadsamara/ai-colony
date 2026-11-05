import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Authorizer, EVALUATION_CONTRACT_VERSION, permissionsForRole } from "@ai-colony/core";
import type { Actor } from "@ai-colony/contracts";
import { createReadOnlyInspection } from "./inspection.js";
import { migrationsFolder } from "./migrate.js";

const LEDGER_TABLES = [
  "ledger_topics",
  "ledger_topic_events",
  "ledger_proposals",
  "ledger_decisions",
  "ledger_taxonomy_versions",
  "ledger_taxonomy_edges",
  "ledger_mapping_versions",
  "ledger_topic_mappings",
  "ledger_snapshots",
  "ledger_retention_events",
] as const;

const LEDGER_MIGRATION_PREFIXES = ["0009_department_capability_ledger", "0010_ledger_measurement_proposals"] as const;

export interface LedgerReadiness {
  status: "operational" | "partial" | "unavailable";
  database: "connected" | "unavailable";
  readOnly: boolean;
  port: string | null;
  dataDirectory: string | null;
  sourceMigrations: string[];
  appliedMigrationVersions: string[];
  missingMigrations: string[];
  tablesPresent: string[];
  tablesMissing: string[];
  triggersPresent: string[];
  triggersMissing: string[];
  certificationAuthority: "demonstrated" | "not_demonstrated";
  governancePath: "demonstrated" | "not_demonstrated";
  evaluationContract: typeof EVALUATION_CONTRACT_VERSION | "unavailable";
  apiRoutesInSource: true;
  apiRunning: "not_checked";
  detail: string;
}

export function ledgerSourceMigrations(): Array<{ tag: string; when: string }> {
  const journal = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries
    .filter((entry) => LEDGER_MIGRATION_PREFIXES.some((prefix) => entry.tag === prefix))
    .map((entry) => ({ tag: entry.tag, when: String(entry.when) }));
}

export async function assessLedgerReadiness(databaseUrl: string): Promise<LedgerReadiness> {
  const source = ledgerSourceMigrations();
  const empty = baseReport(source, "unavailable");
  const inspection = createReadOnlyInspection(databaseUrl);
  try {
    await inspection.assertReadOnly();
    const directory = await inspection.sql<{ data_directory: string }[]>`SHOW data_directory`;
    const port = await inspection.sql<{ port: string }[]>`SHOW port`;
    const applied = await appliedMigrations(inspection.sql);
    const tables = await inspection.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'ledger_%'
    `;
    const triggers = await inspection.sql<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE 'ledger_%'
    `;
    const presentTables = new Set(tables.map((row) => row.table_name));
    const presentTriggers = new Set(triggers.map((row) => row.tgname));
    const requiredTriggers = LEDGER_TABLES.flatMap((table) => [`${table}_no_update`, `${table}_no_delete`]);
    const tablesPresent = LEDGER_TABLES.filter((table) => presentTables.has(table));
    const tablesMissing = LEDGER_TABLES.filter((table) => !presentTables.has(table));
    const triggersPresent = requiredTriggers.filter((name) => presentTriggers.has(name));
    const triggersMissing = requiredTriggers.filter((name) => !presentTriggers.has(name));
    const appliedVersions = new Set(applied);
    const missingMigrations = source.filter((entry) => !appliedVersions.has(entry.when)).map((entry) => entry.tag);
    const authority = await demonstrateAuthority(inspection.sql);
    const schemaReady = missingMigrations.length === 0 && tablesMissing.length === 0 && triggersMissing.length === 0;
    const status = schemaReady && authority.certificationAuthority === "demonstrated"
      ? "operational"
      : schemaReady || tablesPresent.length > 0
        ? "partial"
        : "unavailable";
    return {
      ...empty,
      status,
      database: "connected",
      readOnly: true,
      port: port[0]?.port ?? null,
      dataDirectory: directory[0]?.data_directory ?? null,
      appliedMigrationVersions: applied,
      missingMigrations,
      tablesPresent: [...tablesPresent],
      tablesMissing: [...tablesMissing],
      triggersPresent,
      triggersMissing,
      certificationAuthority: authority.certificationAuthority,
      governancePath: authority.governancePath,
      evaluationContract: EVALUATION_CONTRACT_VERSION,
      detail: status === "operational"
        ? "Ledger schema, immutability triggers, and a stored certification principal are present."
        : status === "partial"
          ? "Some ledger objects exist, but activation is incomplete."
          : "The ledger migration is not applied on this database. A migration file in source code is not a deployment.",
    };
  } finally {
    await inspection.close();
  }
}

function baseReport(source: Array<{ tag: string; when: string }>, status: LedgerReadiness["status"]): LedgerReadiness {
  return {
    status,
    database: "unavailable",
    readOnly: false,
    port: null,
    dataDirectory: null,
    sourceMigrations: source.map((entry) => entry.tag),
    appliedMigrationVersions: [],
    missingMigrations: source.map((entry) => entry.tag),
    tablesPresent: [],
    tablesMissing: [...LEDGER_TABLES],
    triggersPresent: [],
    triggersMissing: LEDGER_TABLES.flatMap((table) => [`${table}_no_update`, `${table}_no_delete`]),
    certificationAuthority: "not_demonstrated",
    governancePath: "not_demonstrated",
    evaluationContract: "unavailable",
    apiRoutesInSource: true,
    apiRunning: "not_checked",
    detail: "The readiness check could not read the database.",
  };
}

async function appliedMigrations(sql: ReturnType<typeof createReadOnlyInspection>["sql"]): Promise<string[]> {
  try {
    const rows = await sql<{ created_at: string | number }[]>`
      SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
    `;
    return rows.map((row) => String(row.created_at));
  } catch {
    return [];
  }
}

async function demonstrateAuthority(sql: ReturnType<typeof createReadOnlyInspection>["sql"]): Promise<{
  certificationAuthority: "demonstrated" | "not_demonstrated";
  governancePath: "demonstrated" | "not_demonstrated";
}> {
  try {
    const principals = await sql<{ id: string; role_name: string }[]>`
      SELECT id::text, role_name FROM principals WHERE role_name = 'system_administrator' LIMIT 1
    `;
    const grants = await sql<{ role_name: string; permission_name: string }[]>`
      SELECT role_name, permission_name FROM role_permissions
      WHERE role_name IN ('system_administrator', 'department_agent')
    `;
    const granted = new Set(grants.map((row) => `${row.role_name}:${row.permission_name}`));
    const administrator = principals[0];
    const authorizer = new Authorizer();
    let certificationAuthority: "demonstrated" | "not_demonstrated" = "not_demonstrated";
    if (
      administrator &&
      granted.has("system_administrator:evaluation:suite:approve") &&
      granted.has("system_administrator:capability:approve")
    ) {
      const actor: Actor = {
        principalId: administrator.id,
        principalType: "system",
        role: "system_administrator",
        agentId: null,
        departmentId: null,
        permissions: permissionsForRole("system_administrator").filter((permission) =>
          granted.has(`system_administrator:${permission}`),
        ),
      };
      authorizer.assert(actor, "evaluation:suite:approve");
      authorizer.assert(actor, "capability:approve");
      certificationAuthority = "demonstrated";
    }
    let governancePath: "demonstrated" | "not_demonstrated" = "not_demonstrated";
    if (granted.has("department_agent:learning:propose") && !granted.has("department_agent:evaluation:suite:approve")) {
      const proposer: Actor = {
        principalId: "readiness-department-agent",
        principalType: "agent",
        role: "department_agent",
        agentId: null,
        departmentId: null,
        permissions: ["learning:propose"],
      };
      authorizer.assert(proposer, "learning:propose");
      let denied = false;
      try {
        authorizer.assert(proposer, "evaluation:suite:approve");
      } catch {
        denied = true;
      }
      governancePath = denied ? "demonstrated" : "not_demonstrated";
    }
    return { certificationAuthority, governancePath };
  } catch {
    return { certificationAuthority: "not_demonstrated", governancePath: "not_demonstrated" };
  }
}
