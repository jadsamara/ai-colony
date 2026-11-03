# Ledger activation runbook

The canonical ledger is not activated. Run these steps only after an operator approves the write. Use the existing `DATABASE_URL` for `127.0.0.1:5433` and database `ai_colony`. Do not print that URL, and do not use port 5434.

## 1. Preflight

```bash
pnpm ledger:ready
```

Stop unless the report shows `readOnly: true`, port `5433`, data directory `/tmp/ai-colony-pg`, and `status: unavailable`, with both `0009_department_capability_ledger` and `0010_ledger_measurement_proposals` listed in `missingMigrations`.

## 2. Backup

```bash
pg_dump --format=custom --file="$BACKUP_PATH" --dbname="$DATABASE_URL"
```

Choose `$BACKUP_PATH` outside the repository. Confirm the target is port 5433 and database `ai_colony` before running the dump.

## 3. Activate

```bash
pnpm db:migrate
```

Expected output is `Migrations applied`. The command creates the ten ledger tables, allows measurement proposals, and installs twenty append-only triggers. It does not certify a snapshot or change evaluation rows.

## 4. Verify

```bash
pnpm ledger:ready
```

`missingMigrations` should be empty, all ten ledger tables present, and all twenty `ledger_%` triggers present. `status` becomes `operational` only when those objects exist and the stored system administrator still passes the certification check. Read `status`. A zero exit code only means the report was produced.

Read-only confirmation:

```sql
SELECT created_at FROM drizzle.__drizzle_migrations
WHERE created_at IN (1793551000000, 1793552000000)
ORDER BY created_at;
SELECT count(*) FROM pg_trigger
WHERE NOT tgisinternal AND tgname LIKE 'ledger_%';
SELECT count(*) FROM evaluation_runs;
```

Expect both migration timestamps, 20 triggers, and the same evaluation count as the preflight (5 at the time of this runbook).

## 5. Recover

If `pnpm db:migrate` fails, do not drop ledger tables. Run it again after the cause is fixed. A failed Drizzle migration rolls back and is not recorded. A failed trigger pass is repaired by the same command.

Restoring `$BACKUP_PATH` with `pg_restore` returns the database to the backup. That is not a down migration.

## 6. Certify later

Certification is a separate operator action. Propose with `POST /api/v1/capabilities/measurements/proposals`, review with `GET /api/v1/capabilities/measurements/proposals/:id`, and decide with `POST /api/v1/capabilities/measurements/proposals/:id/decision`. The certifier must already hold `evaluation:suite:approve`. The system administrator is that principal. Do not grant the permission to the Evaluation department agent as part of activation.
