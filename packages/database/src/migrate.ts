import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client.js";

const AUDIT_IMMUTABILITY_SQL = `
CREATE OR REPLACE FUNCTION colony_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION colony_reject_audit_mutation();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION colony_reject_audit_mutation();
`;

export function migrationsFolder(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, "migrations"), join(moduleDir, "../src/migrations")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  throw new Error(
    "Could not find Drizzle migrations. Run pnpm db:generate before pnpm db:migrate.",
  );
}

export async function migrateDatabase(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await db.execute(sql.raw(AUDIT_IMMUTABILITY_SQL));
}
