# M10.1 canonical activation preflight

Status: **M10.1 preflight complete — awaiting operator approval.**

Canonical PostgreSQL has not been backed up and migration `0011` has not been applied. No live inference was run. This document does not report activation as complete.

## Git branch and commit

- Branch: `m10.1-routing-activation`
- Base: `a5e7f1e` on `m10-governed-model-routing`
- M10 implementation commit: `04afc2996e52f451c287423fe1aff9e9874a79fd`
- Preflight commit: `10058adfbef5e32dd3291fbfcf33d66a392466c6`

Untracked files left out of the commit: `docs/audits/` and `docs/milestones/M9_1_CANONICAL_ACTIVATION_REPORT.md`.

## Department allowlist findings

Canonical read-only inspection on `127.0.0.1:5433` / `ai_colony` found 13 department rows. Twelve are active seeded departments. One is proposed. The policy keys off stable department ids in `LEGACY_DEPARTMENT_IDS`, not names or row order.

| Department | Id | Status | Existed before M10 | Active assignment | Compatibility default | Reason | Operational inference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CEO | `00000000-0000-4000-8000-000000000011` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Orchestration | `00000000-0000-4000-8000-000000000012` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Monitoring | `00000000-0000-4000-8000-000000000013` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Evolution | `00000000-0000-4000-8000-000000000014` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Weight Optimization | `00000000-0000-4000-8000-000000000015` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Memory & Forgetting | `00000000-0000-4000-8000-000000000016` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Evaluation | `00000000-0000-4000-8000-000000000017` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Research | `00000000-0000-4000-8000-000000000018` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Math | `00000000-0000-4000-8000-000000000019` | active | yes, seed | `shared_base` Qwen3-8B `...0101`, version 1, active | not needed | explicit assignment | authorized, `authorized_assignment` |
| Reasoning | `00000000-0000-4000-8000-00000000001a` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Science | `00000000-0000-4000-8000-00000000001b` | active | yes, seed | `shared_base` Qwen3-8B `...0101`, version 1, active | not needed | explicit assignment | authorized, `authorized_assignment` |
| Gaming | `00000000-0000-4000-8000-00000000001c` | active | yes, seed | none | yes | seeded id | authorized, `authorized_legacy_default` |
| Engineering | `123e24dc-c194-43e0-91a7-c4df153e5030` | proposed | yes, API row created 2026-10-31 | none | no | not a seeded id; status is proposed | denied, `department_inactive` |

`pnpm routing:ready` evaluated these rows read-only. `activeDepartmentCount` is 12. `activeDepartmentsDenied` is empty. Engineering is denied because its lifecycle status is `proposed`, not because a name lookup failed. The allowlist was not expanded. A rejected assignment on an allowlisted department still returns `disabled_assignment` and overrides the compatibility default. No active department would lose inference access.

The shared model `00000000-0000-4000-8000-000000000101` is registered. Its registry status remains `not_deployed`. The compatibility policy authorizes that specific id for the 12 seeded departments.

## Migration SQL review

`0011_routing_decisions` is the only journal entry after `0010_ledger_measurement_proposals`. Its `when` is `1793553000000`. The SQL file:

- Creates `routing_decisions`.
- Adds foreign keys to `objective_tasks`, `objective_runs`, `departments`, `department_model_assignments`, and `models`, all `ON DELETE restrict`.
- Adds checks for `authorization`, `fallback_status = 'disabled'`, and `execution_verification`.
- Adds partial unique indexes `routing_decisions_task_unique` and `routing_decisions_objective_purpose_unique`.

The SQL contains no `DROP TABLE`, `DELETE`, `UPDATE`, or `ALTER TABLE`. It does not change department rows, model assignments, evaluation history, or ledger history.

## Migration runner side effects

`pnpm db:migrate` loads `.env` through `dotenv/config` and calls `migrateDatabase`. That function does three things:

1. `CREATE EXTENSION IF NOT EXISTS vector`. The extension is already installed on canonical PostgreSQL.
2. Applies pending Drizzle migrations in one transaction. The only pending migration is `0011`. The runner inserts the matching `drizzle.__drizzle_migrations` row in that same transaction.
3. In a second transaction, replaces `colony_reject_audit_mutation`, `colony_reject_training_mutation`, and `colony_reject_published_benchmark`, then drops and recreates the existing immutability triggers. The refreshed triggers are:
   - `audit_events_no_update`, `audit_events_no_delete`
   - `training_examples_no_update`, `training_examples_no_delete`
   - `training_artifacts_no_update`
   - `candidate_evaluations_no_update`
   - `benchmark_items_no_update`, `benchmark_items_no_delete`
   - `evaluation_item_results_no_update`
   - `candidate_gate_decisions_no_update`
   - `benchmark_versions_no_republish`
   - `learning_cycle_events_no_update`, `learning_cycle_events_no_delete`
   - `learning_outcomes_no_update`
   - `knowledge_validations_no_update`
   - `improvement_decisions_no_update`
   - `deployment_decisions_no_update`
   - `training_experiments_no_update`, `training_experiments_no_delete`
   - For each of `ledger_topics`, `ledger_topic_events`, `ledger_proposals`, `ledger_decisions`, `ledger_taxonomy_versions`, `ledger_taxonomy_edges`, `ledger_mapping_versions`, `ledger_topic_mappings`, `ledger_snapshots`, `ledger_retention_events`, and `routing_decisions`: `*_no_update` and `*_no_delete`

The trigger functions keep the same exception behavior. This refresh is an audited runner side effect, not a second schema migration. It does not rewrite table rows. `pnpm db:migrate` must not be run until the approval below, because `.env` points at canonical PostgreSQL.

## Integration harness

`tests/helpers/env.ts` no longer reads `.env` and no longer rewrites a URL into database `ai_colony`. Integration tests require `INTEGRATION_DATABASE_URL`. The guard runs at import, before `createDatabase`, migration, fixture insert, or cleanup. It rejects ports other than `5435`, database name `ai_colony`, the canonical data-directory string, non-loopback hosts, and a missing URL even when `DATABASE_URL` is present.

`tests/global-setup.ts` starts only `docker-compose.integration.yml` with project name `ai-colony-m101`. It does not run the root Compose file. The isolated file binds PostgreSQL to `127.0.0.1:5435` and RabbitMQ to `127.0.0.1:5673`, uses database `colony_m101_integration`, and does not use the production container names or volumes. The broker test reads `INTEGRATION_RABBITMQ_URL` and refuses port `5672`.

Negative tests in `tests/unit/integration-isolation.test.ts` reject the unsafe targets without opening a connection.

## Test results

Disposable PostgreSQL 17 and RabbitMQ were `ai-colony-m101-postgres` and `ai-colony-m101-rabbitmq`. Port `5434` was not contacted.

Unit suite, with `LEDGER_TEST_DATABASE_URL` and `ROUTING_TEST_DATABASE_URL` on port `5435`:

- 187 passed
- 0 skipped
- 0 failed

That run includes the M10 routing unit tests, the M10 routing database tests, and the M9/M9.1 ledger database tests. `assessRoutingReadiness` reported `ready` on the fresh seeded routing database and `liveInference: not_run`.

Integration suite, with `INTEGRATION_DATABASE_URL` and `INTEGRATION_RABBITMQ_URL`:

- 15 files passed
- 51 tests passed
- 0 skipped
- 0 failed

`tests/smoke/real-model.test.ts` was not run because it generates tokens.

`tsc -p tsconfig.typecheck.json --noEmit` passed. ESLint on the M10.1 files passed.

The ledger activation snapshot count is now limited to the department created by that test. A second disposable test sharing the database can no longer change the expected count.

## Canonical database identity

Read-only transaction. `transaction_read_only = on`.

| Field | Value |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `5433` |
| Database | `ai_colony` |
| User | `colony` |
| Server | PostgreSQL 17.5 (Homebrew) |
| Data directory | `/tmp/ai-colony-pg` |
| Migration rows | 11 |
| Latest migration timestamp | `1793552000000` (`0010`) |
| `routing_decisions` | absent |
| Ledger topic, snapshot, proposal, decision, and retention rows | 0 |
| Active migration sessions | 0 |

Eighteen pgAdmin sessions were idle and not waiting on a lock. No API or worker session was connected. They do not block a later migration.

`pnpm routing:ready` connected read-only, reported `status: not_ready` and `migration0011: pending`, and exited 1. After that command, migration count was still 11, `routing_decisions` was still absent, departments were still 13, assignments were still 2, and audit events were still 203.

## Baseline checksums

Expression: `md5` of `string_agg` over the ordered identity columns named below. Empty tables use the MD5 of an empty string.

| Table | Rows | Checksum input | MD5 |
| --- | --- | --- | --- |
| departments | 13 | `id\|status` | `59a9bd001e4498592de0a2a3e8d55e58` |
| department_model_assignments | 2 | `id\|status\|version\|registry_model_id` | `c0ac871016ce7c45c9fc71c4a0ecded9` |
| models | 3 | `id\|status` | `10e66956ca060a1b764fd17b459cd419` |
| model_runtimes | 1 | `model_id\|runtime_status\|expected_alias` | `8f4d7a27e702f9a07cece6d0b66660a3` |
| evaluation_runs | 5 | `id\|status` | `bb8b09aabdaaa8471f526bd2f85ea8af` |
| evaluation_item_results | 100 | `id\|task_correct` | `27683b9894ccd499efff4fdfa6793a98` |
| audit_events | 203 | `event_id\|event_type` | `17976a7716533a2d5bb23c923461fd5c` |
| message_outbox | 42 | `id\|status` | `345c10a5ed1bded7f25add3f6906e9a8` |
| principals | 11 | `id\|role_name` | `50d998c45c2573f8d15e7d8a9f6e55eb` |
| role_permissions | 188 | `role_name\|permission_name` | `51353131294f9e46da49a3235d0f4e70` |

Outbox status: 20 pending, 22 published.

These expressions are the M10.1 baseline. They are not claimed to equal earlier checksums that used a different column list.

## Backup and restore plan

Backup directory `/Users/jad/Desktop/ai-colony-backups/` exists and is not inside `/tmp/ai-colony-pg`. The data volume has about 158 GiB free. `pg_dump` and the server are both PostgreSQL 17.5.

After the exact approval below, and only then:

1. `pg_dump` custom format to `ai_colony-pre-m101-<UTC timestamp>.dump`.
2. Require exit status 0, a nonempty file, `pg_restore --list` success, and a SHA-256.
3. Restore into a new disposable PostgreSQL 17 + pgvector database on port `5435`, not over `ai_colony`.
4. Compare the restored checksums with this baseline.
5. Stop if any check fails. Do not restore the archive over canonical PostgreSQL without a separate approval.

## Remaining risks

- The migration runner refreshes immutability triggers as well as applying `0011`. The trigger definitions do not change row contents, but the second transaction is still a canonical catalog write.
- Idle pgAdmin sessions are connected. They were not idle in a transaction during preflight.
- Execution digests remain unverified until a backend can attest them. Readiness does not generate tokens and does not claim live inference readiness.
- Engineering stays outside the allowlist. Activating it later does not grant Qwen3-8B without an explicit assignment.

## Exact proposed canonical mutations

Only after approval:

- Apply migration `0011_routing_decisions` and its Drizzle history row.
- `CREATE EXTENSION IF NOT EXISTS vector`, which is already installed.
- Recreate the immutability functions and triggers listed above, including the new routing triggers.
- Do not insert routing decisions, change assignments, change departments, or backfill ledger or evaluation rows.

## Approval

Canonical activation has not been performed.

**APPROVE M10.1 CANONICAL ACTIVATION ON 127.0.0.1:5433 / ai_colony — MIGRATION 0011 ONLY**
