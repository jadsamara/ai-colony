import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";
import { migrateDatabase } from "./migrate.js";

export function assertCanonicalTarget(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.port === "5434") {
    throw new Error("Refusing PostgreSQL port 5434");
  }
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "5433" || name !== "ai_colony") {
    throw new Error("Canonical migration requires 127.0.0.1:5433/ai_colony");
  }
}

export function assertAdditiveMigration(sql: string): void {
  const stripped = sql.replace(/--.*$/gm, "");
  if (/^\s*(drop|delete|truncate|update)\b/im.test(stripped)) {
    throw new Error("Refusing migration SQL that is not additive");
  }
}

export interface CanonicalIdentity {
  database: string;
  port: string;
  dataDirectory: string;
  version: string;
  servingTable: string | null;
  routingDecisions: number;
}

export async function readCanonicalIdentity(db: Database): Promise<CanonicalIdentity> {
  const rows = await db.execute<{
    current_database: string;
    port: string;
    data_directory: string;
    version: string;
    serving_table: string | null;
    routing_decisions: number;
  }>(sql`
    select current_database() as current_database,
           inet_server_port()::text as port,
           current_setting('data_directory') as data_directory,
           version() as version,
           to_regclass('public.department_serving_instances')::text as serving_table,
           (select count(*) from routing_decisions)::int as routing_decisions
  `);
  const row = rows[0];
  if (!row || row.current_database !== "ai_colony") {
    throw new Error("Connected database is not ai_colony");
  }
  return {
    database: row.current_database,
    port: row.port,
    dataDirectory: row.data_directory,
    version: row.version,
    servingTable: row.serving_table,
    routingDecisions: Number(row.routing_decisions),
  };
}

export async function applyCanonicalMigration(databaseUrl: string, migrationSql: string): Promise<{
  identityBefore: CanonicalIdentity;
  applied: boolean;
  routingDecisionsAfter: number;
}> {
  assertCanonicalTarget(databaseUrl);
  assertAdditiveMigration(migrationSql);
  const { db, close } = createDatabase(databaseUrl);
  try {
    const identityBefore = await readCanonicalIdentity(db);
    if (identityBefore.port !== "5433") {
      throw new Error(`Server port is ${identityBefore.port}, expected 5433`);
    }
    if (identityBefore.dataDirectory !== "/tmp/ai-colony-pg") {
      throw new Error(`Data directory is ${identityBefore.dataDirectory}, expected /tmp/ai-colony-pg`);
    }
    if (!identityBefore.version.startsWith("PostgreSQL 17")) {
      throw new Error(`PostgreSQL version is not 17: ${identityBefore.version}`);
    }
    let applied = false;
    if (!identityBefore.servingTable) {
      await migrateDatabase(db);
      applied = true;
    }
    const after = await readCanonicalIdentity(db);
    if (!after.servingTable) {
      throw new Error("department_serving_instances was not created");
    }
    if (after.routingDecisions !== identityBefore.routingDecisions) {
      throw new Error("Routing history count changed during migration");
    }
    return { identityBefore, applied, routingDecisionsAfter: after.routingDecisions };
  } finally {
    await close();
  }
}

export function readMigrationFile(path: string): string {
  return readFileSync(path, "utf8");
}

export async function servingConstraintNames(db: Database): Promise<string[]> {
  const rows = await db.execute<{ conname: string }>(sql`
    select conname from pg_constraint
    where conname like 'department_serving%'
       or conname like 'department_agent_checkpoints%'
    order by conname
  `);
  return rows.map((row) => row.conname);
}
