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

CREATE OR REPLACE FUNCTION colony_reject_training_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS training_examples_no_update ON training_examples;
CREATE TRIGGER training_examples_no_update
BEFORE UPDATE ON training_examples
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS training_examples_no_delete ON training_examples;
CREATE TRIGGER training_examples_no_delete
BEFORE DELETE ON training_examples
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS training_artifacts_no_update ON training_artifacts;
CREATE TRIGGER training_artifacts_no_update
BEFORE UPDATE ON training_artifacts
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS candidate_evaluations_no_update ON candidate_evaluations;
CREATE TRIGGER candidate_evaluations_no_update
BEFORE UPDATE ON candidate_evaluations
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS benchmark_items_no_update ON benchmark_items;
CREATE TRIGGER benchmark_items_no_update
BEFORE UPDATE ON benchmark_items
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS benchmark_items_no_delete ON benchmark_items;
CREATE TRIGGER benchmark_items_no_delete
BEFORE DELETE ON benchmark_items
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS evaluation_item_results_no_update ON evaluation_item_results;
CREATE TRIGGER evaluation_item_results_no_update
BEFORE UPDATE ON evaluation_item_results
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS candidate_gate_decisions_no_update ON candidate_gate_decisions;
CREATE TRIGGER candidate_gate_decisions_no_update
BEFORE UPDATE ON candidate_gate_decisions
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

CREATE OR REPLACE FUNCTION colony_reject_published_benchmark()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'published benchmark versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS benchmark_versions_no_republish ON benchmark_versions;
CREATE TRIGGER benchmark_versions_no_republish
BEFORE UPDATE ON benchmark_versions
FOR EACH ROW
EXECUTE FUNCTION colony_reject_published_benchmark();

DROP TRIGGER IF EXISTS learning_cycle_events_no_update ON learning_cycle_events;
CREATE TRIGGER learning_cycle_events_no_update
BEFORE UPDATE ON learning_cycle_events
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS learning_cycle_events_no_delete ON learning_cycle_events;
CREATE TRIGGER learning_cycle_events_no_delete
BEFORE DELETE ON learning_cycle_events
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS learning_outcomes_no_update ON learning_outcomes;
CREATE TRIGGER learning_outcomes_no_update
BEFORE UPDATE ON learning_outcomes
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS knowledge_validations_no_update ON knowledge_validations;
CREATE TRIGGER knowledge_validations_no_update
BEFORE UPDATE ON knowledge_validations
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS improvement_decisions_no_update ON improvement_decisions;
CREATE TRIGGER improvement_decisions_no_update
BEFORE UPDATE ON improvement_decisions
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();

DROP TRIGGER IF EXISTS deployment_decisions_no_update ON deployment_decisions;
CREATE TRIGGER deployment_decisions_no_update
BEFORE UPDATE ON deployment_decisions
FOR EACH ROW
EXECUTE FUNCTION colony_reject_training_mutation();
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
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await db.execute(sql.raw(AUDIT_IMMUTABILITY_SQL));
}
