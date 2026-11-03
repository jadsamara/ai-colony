# M9.1 Ledger Activation Report

## 1. Executive summary

The Department Capability Ledger is implemented and tested in isolation. It is not operational on the canonical database.

Migration `0009_department_capability_ledger` and the follow-on measurement-proposal migration `0010_ledger_measurement_proposals` apply once on a disposable PostgreSQL database, survive a second runner pass, and enforce foreign keys and append-only triggers. The proposal, taxonomy, mapping, synthetic-evidence, certification, retention, and history lifecycle passes there. The ledger comparison interval is now Newcombe's paired-difference interval. Exact McNemar remains the hypothesis test.

`pnpm ledger:ready` reads canonical PostgreSQL without writing. On 2 November 2026 it reported `status: unavailable` on `127.0.0.1:5433`, database `ai_colony`, data directory `/tmp/ai-colony-pg`. `ledger_topics` is absent. The five existing evaluation runs are unchanged. No canonical migration, permission change, snapshot, or audit write was performed.

## 2. Migration audit findings

Drizzle applies each pending SQL file inside one transaction and records `drizzle.__drizzle_migrations` only after that SQL succeeds. A failed file therefore leaves no hash and rolls back its schema changes. The runner compares the latest stored `created_at` with the journal timestamp, so a later re-run does not execute SQL that is already recorded.

`0009_department_capability_ledger` creates ten tables:

- `ledger_topics`
- `ledger_topic_events`
- `ledger_proposals`
- `ledger_decisions`
- `ledger_taxonomy_versions`
- `ledger_taxonomy_edges`
- `ledger_mapping_versions`
- `ledger_topic_mappings`
- `ledger_snapshots`
- `ledger_retention_events`

Foreign keys use `ON DELETE RESTRICT`. Topic identity is separate from versioned names. Snapshot counts require a positive sample whose correct and incorrect counts add up to that sample. Digest columns stay constrained to 64 hex characters.

`0010_ledger_measurement_proposals` only replaces `ledger_proposals_kind_check` so `kind` may be `taxonomy`, `mapping`, or `measurement`. It does not copy or rewrite rows. It is required for the certification workflow because a measurement cannot be proposed under the original two-value check.

`migrateDatabase` creates the `vector` extension, runs the Drizzle migrator, then installs immutability functions and triggers in their own transaction. `colony_reject_training_mutation` is created before the ledger `DO` block references it. That block installs `BEFORE UPDATE` and `BEFORE DELETE` triggers named `<table>_no_update` and `<table>_no_delete` on all ten ledger tables. Re-running the script drops and recreates those triggers. It does not delete ledger rows.

Existing evaluation and governance tables are not altered by `0009` or `0010`. Activation does not backfill historical evaluations into snapshots.

## 3. Isolated database configuration

The disposable database used for M9.1 was:

- Container name: `ai-colony-m91-ledger`
- Image: `pgvector/pgvector:pg16` (already present locally)
- Bind: `127.0.0.1:5435` to the container's `5432`
- Database name: `colony_ledger_m91`
- Dedicated role supplied only through the container environment and `LEDGER_TEST_DATABASE_URL`

Port 5435 was free before the container started. The container was removed after the suite. The Docker PostgreSQL container publishing port 5434 was not stopped, recreated, or queried. `assertDisposableDatabaseUrl` refuses ports 5433 and 5434 and refuses the database name `ai_colony`.

When `LEDGER_TEST_DATABASE_URL` is set, the unit Vitest config disables file parallelism so two suites cannot race `CREATE EXTENSION`.

Recreation command, with credentials chosen by the operator and not stored in this report:

```bash
docker run -d --name ai-colony-m91-ledger \
  --publish 127.0.0.1:5435:5432 \
  --env POSTGRES_USER=<dedicated-user> \
  --env POSTGRES_PASSWORD=<dedicated-password> \
  --env POSTGRES_DB=colony_ledger_m91 \
  pgvector/pgvector:pg16
```

```bash
export LEDGER_TEST_DATABASE_URL=postgres://<dedicated-user>:<dedicated-password>@127.0.0.1:5435/colony_ledger_m91
pnpm exec vitest run --config vitest.unit.config.ts
```

## 4. Governance lifecycle test results

`tests/unit/ledger-activation.test.ts` ran the full lifecycle on the disposable database.

| Stage | Result |
| --- | --- |
| Topic proposal | A department proposes only for itself. Another department is denied. The topic row records the proposing principal and provenance. |
| Taxonomy approval | The proposing department agent and the CEO are denied. The same principal is denied even with the administrator role (`SELF_APPROVAL`). A different system administrator approves and creates taxonomy version 1. The earlier tree remains readable. |
| Benchmark mapping | Mapping items carry content digests and provenance. The department agent cannot approve. An approved mapping can be replaced by a new version without changing the previous version's rows. |
| Evaluation evidence | The fixture manifest uses provenance `synthetic`, an evidence reference beginning `synthetic:`, and provenance text that says synthetic. An unlabeled synthetic manifest is rejected. No model response was generated. |
| Certification | The department agent and the Evaluation department agent are denied. The system administrator reviews the manifest, sees `synthetic: true`, and certifies. The snapshot stores that principal and the manifest fingerprint. Repeating the same evidence returns the original snapshot. A second decision on the same proposal conflicts. |
| Retention | Retain and archive leave the row visible. Revoke hides it from the owning department and leaves it readable by the administrator. The three events remain. An ordinary department agent cannot change retention. |
| History | Two measurements stay in time order. The later, lower accuracy is the latest measurement. An untouched topic is reported as untested. A department outside the approved reader set cannot read another department's history. |

Update and delete of a certified snapshot raise the immutability trigger. A topic insert that throws inside a transaction is absent afterward.

## 5. Certification workflow

No new authentication system and no new permission were added. The seeded system administrator remains the certification authority because that role already holds `evaluation:suite:approve` and `capability:approve`. The Evaluation department agent remains a `department_agent` and still cannot certify.

The operator workflow uses the existing ledger service and these routes:

1. `POST /api/v1/capabilities/measurements/proposals` records a proposed measurement. The caller needs `learning:propose` and must belong to the scored department.
2. `GET /api/v1/capabilities/measurements/proposals/:id` returns the parsed M8.2 manifest, mapping version, synthetic flag, and whether the evidence is certifiable.
3. The reviewer confirms the mapping version is approved, the item identities match that mapping, and synthetic evidence is labeled.
4. `POST /api/v1/capabilities/measurements/proposals/:id/decision` with `approved` or `rejected` requires `evaluation:suite:approve`, a different principal from the proposer, and a department other than the scored department.
5. Rejection appends a decision and does not create a snapshot. Invalid evidence throws before a decision is recorded, so the proposal can still be rejected explicitly.
6. Approval appends the decision and the snapshot. Identical evidence returns the existing snapshot with `repeated: true`.
7. `GET /api/v1/capabilities/snapshots/:id` returns the certified snapshot to an authorized reader.

Direct SQL inserts are not part of the workflow.

## 6. Statistical correction

Ledger comparisons no longer treat a Wilson interval on discordant pairs as a confidence interval for the paired accuracy difference.

The ledger interval is Newcombe's method 10 for the difference between two paired proportions (candidate accuracy minus baseline accuracy), using the exact 97.5 percent normal quantile `1.959963984540054`, Wilson marginal limits, and the continuity-corrected phi coefficient from Newcombe, Statistics in Medicine 1998;17:2635-2650. Limits are clipped to `[-1, 1]`. The method name on a completed comparison is `newcombe-1998-method-10`.

Reference values locked by `tests/unit/paired-interval.test.ts`:

| Case | Interval |
| --- | --- |
| 20 both correct, 12 candidate only, 2 baseline only, 16 neither | 0.056156424841748 to 0.329206995400141 |
| 54 concordant correct pairs | -0.066413588090896 to 0.066413588090896 |
| 30 candidate-only improvements | 0.839467819862384 to 1 |
| 30 baseline-only regressions | -1 to -0.839467819862384 |
| One discordant improvement | includes 0 and reaches 1 |
| Balanced discordant counts | symmetric about 0 |
| Zero discordant pairs | non-zero width that contains 0 |

`discordantPairWilsonInterval` remains available and is documented as a conditional discordant-share interval. For 30 improvements it is lower than the Newcombe bound and is not used for the ledger verdict.

`analyzePairedRuns` still reports the Wald interval and exact McNemar. `deploymentAuthorization` remains `separate_decision_required`. Historical evaluation scores were not rewritten.

## 7. Operational readiness command

```bash
pnpm ledger:ready
```

The command builds the contracts, core, and database packages, then runs `apps/api/src/ledger-readiness-cli.ts`. It opens `DATABASE_URL` through a dedicated connection with `default_transaction_read_only=on` and checks `transaction_read_only = on`. It refuses port 5434. It does not start the API.

The JSON report includes connectivity, port, data directory, source migration names, applied migration timestamps, missing migrations, ledger tables, immutability triggers, whether a stored `system_administrator` principal and the stored `role_permissions` rows can pass `Authorizer.assert` for certification, whether a stored `department_agent` grant can propose and is not granted certification, the evaluation contract version present in source, and `apiRunning: not_checked`.

`status` is `operational` only when both ledger migrations are recorded, all ten tables and twenty triggers exist, and certification authorization is demonstrated from stored rows. Source files alone cannot produce that status. Exit code 0 means a report was produced. Exit code 1 means the database could not be read. Operators must read `status`.

## 8. Test results

Typecheck: `tsc -p tsconfig.typecheck.json --noEmit` passed.

ESLint on the M9.1 source and tests passed.

Default unit suite, without `LEDGER_TEST_DATABASE_URL`:

- 130 passed
- 2 skipped (`capability-ledger-db.test.ts`, `ledger-activation.test.ts`)
- 0 failed

Isolated suite on `127.0.0.1:5435`, database `colony_ledger_m91`:

- 132 passed
- 0 skipped
- 0 failed

The compose integration suite was not run. It can start services bound to the canonical database. No model inference, training, Ollama load, or RabbitMQ replay was performed.

## 9. Canonical activation plan

Do not run this plan until an operator explicitly approves the canonical write.

Preconditions, all confirmed by the read-only check above:

- Host `127.0.0.1`, port `5433`, database `ai_colony`, data directory `/tmp/ai-colony-pg`.
- `transaction_read_only = on` for the inspection session.
- `to_regclass('public.ledger_topics')` is null.
- `evaluation_runs` count is 5.
- The connection is not port 5434.
- A backup from the procedure in section 10 exists.
- `pnpm ledger:ready` still reports `status: unavailable` and lists `0009_department_capability_ledger` and `0010_ledger_measurement_proposals` as missing.

Environment: `DATABASE_URL` must already point at that canonical database. The migrator requires no other variable. Do not place the password in a shell history note or this report.

Command, and only after approval:

```bash
pnpm db:migrate
```

That builds the database package and runs `packages/database/dist/migrate-cli.js`, which calls `migrateDatabase`. Expected effect: apply `0009` and `0010`, record journal timestamps `1793551000000` and `1793552000000`, install the twenty ledger triggers, and print `Migrations applied`. No snapshot, taxonomy, permission, or evaluation row is inserted.

Post-check:

```bash
pnpm ledger:ready
```

Expected: `missingMigrations` empty, all ten tables present, all twenty triggers present, `readOnly: true`, port `5433`, data directory `/tmp/ai-colony-pg`. If the existing system administrator and role grants are still stored, `certificationAuthority` stays `demonstrated` and `status` becomes `operational`. That status describes schema and authorization readiness. It does not mean a capability has been certified.

Verification queries, still on a read-only session:

```sql
SELECT created_at FROM drizzle.__drizzle_migrations
WHERE created_at IN (1793551000000, 1793552000000)
ORDER BY created_at;
SELECT conname FROM pg_constraint
WHERE conname = 'ledger_proposals_kind_check';
SELECT count(*) FROM pg_trigger
WHERE NOT tgisinternal AND tgname LIKE 'ledger_%';
SELECT count(*) FROM evaluation_runs;
```

The constraint definition should allow `measurement`. The trigger count should be 20. The evaluation count should remain 5.

## 10. Backup and recovery plan

Backup, before the activation command, to a path the operator chooses:

```bash
pg_dump --format=custom --file="$BACKUP_PATH" --dbname="$DATABASE_URL"
```

Confirm the URL host, port, and database name before running it. Use port 5433 and database `ai_colony`.

Forward repair: if activation fails inside the Drizzle transaction, the migration hash is not recorded and the schema change rolls back. Fix the cause and run `pnpm db:migrate` again. If the tables commit and the later trigger transaction fails, run `pnpm db:migrate` again. Trigger installation is idempotent and does not delete certified history.

There is no down migration. Do not drop ledger tables to undo activation. Restoring `$BACKUP_PATH` with `pg_restore` replaces database state with the backup. That is a point-in-time restore, not a reversal of the ledger, and it discards writes made after the dump.

## 11. Remaining blockers

- Canonical PostgreSQL does not contain the ledger schema.
- Canonical PostgreSQL contains no certified capability snapshot.
- Activation still requires the operator backup and an explicit decision to run `pnpm db:migrate`.
- The Evaluation department agent cannot certify. That is the current authorization design, not a missing grant added by this milestone.
- Historical colony evaluations were not imported. They remain separate from any future certified snapshot.

## 12. M10 readiness assessment

M10 model routing should not start from this branch until the operator has applied and verified the ledger on canonical PostgreSQL, or has explicitly accepted that routing work proceeds without a deployed ledger.

Additional gaps that M9.1 did not change:

- Serving still does not follow `department_model_assignments`.
- A ledger comparison does not authorize deployment. That remains a separate decision.
- The stored colony evaluations and the later research runs are not one comparable series.
- No adapter promotion or department model assignment was changed.

## 13. Canonical database safety

Confirmed after implementation, through a read-only session:

- `transaction_read_only` is `on`.
- Port is `5433`.
- Data directory is `/tmp/ai-colony-pg`.
- `ledger_topics` does not exist.
- `evaluation_runs` contains 5 rows.
- `pnpm ledger:ready` reports `unavailable`.
- Port 5434 still belongs to the existing `ai-colony-postgres` container and was not modified.
- The disposable `ai-colony-m91-ledger` container was removed.
- No model was loaded, unloaded, trained, or queried.
