# M10.1 canonical activation report

Status: **canonical schema activated and independently verified.**

These states are separate:

| State | Result |
| --- | --- |
| Code implemented | Yes. Isolation harness, readiness command, and preflight are on `m10.1-routing-activation`. |
| Tests passed | Yes, before activation. Unit 187 passed. Integration 51 passed. Real-model smoke tests were not run. |
| Canonical schema activated | Yes. Migration `0011_routing_decisions` is recorded on `127.0.0.1:5433` / `ai_colony`. |
| Runtime services started | No. No production worker, API process, or RabbitMQ publisher was started. |
| Live inference demonstrated | No. `pnpm routing:ready` reports `liveInference: not_run`. |

## 1. Implementation summary

M10.1 verified the M10 routing policy against the canonical department rows, audited migration `0011`, and made the integration suite refuse canonical PostgreSQL. After the exact operator approval, the canonical database was backed up, the archive was restored into a disposable database, and migration `0011` was applied through `pnpm db:migrate`. A separate read-only session then confirmed the schema, the immutability triggers, and the historical checksums. No routing decision row was inserted. No model assignment was changed. No token was generated.

## 2. Git branch and commit

- Branch: `m10.1-routing-activation`
- M10 implementation commit: `04afc2996e52f451c287423fe1aff9e9874a79fd`
- Preflight commit: `10058adfbef5e32dd3291fbfcf33d66a392466c6`
- Preflight tip before activation: `4c4fad2`
- Activation report commit: `b6542189b14d0f272769116d162a75ff97cf7866`

`docs/audits/` and `docs/milestones/M9_1_CANONICAL_ACTIVATION_REPORT.md` remain untracked.

## 3. Department authorization matrix

The policy uses the stable ids in `LEGACY_DEPARTMENT_IDS`. Names and row order are not the key. Thirteen rows exist. Twelve are active and authorized. Engineering is proposed and is not on the allowlist.

| Department | Id | Status | Assignment | Authorization |
| --- | --- | --- | --- | --- |
| CEO | `00000000-0000-4000-8000-000000000011` | active | none | `authorized_legacy_default` |
| Orchestration | `00000000-0000-4000-8000-000000000012` | active | none | `authorized_legacy_default` |
| Monitoring | `00000000-0000-4000-8000-000000000013` | active | none | `authorized_legacy_default` |
| Evolution | `00000000-0000-4000-8000-000000000014` | active | none | `authorized_legacy_default` |
| Weight Optimization | `00000000-0000-4000-8000-000000000015` | active | none | `authorized_legacy_default` |
| Memory & Forgetting | `00000000-0000-4000-8000-000000000016` | active | none | `authorized_legacy_default` |
| Evaluation | `00000000-0000-4000-8000-000000000017` | active | none | `authorized_legacy_default` |
| Research | `00000000-0000-4000-8000-000000000018` | active | none | `authorized_legacy_default` |
| Math | `00000000-0000-4000-8000-000000000019` | active | shared-base Qwen3-8B v1 | `authorized_assignment` |
| Reasoning | `00000000-0000-4000-8000-00000000001a` | active | none | `authorized_legacy_default` |
| Science | `00000000-0000-4000-8000-00000000001b` | active | shared-base Qwen3-8B v1 | `authorized_assignment` |
| Gaming | `00000000-0000-4000-8000-00000000001c` | active | none | `authorized_legacy_default` |
| Engineering | `123e24dc-c194-43e0-91a7-c4df153e5030` | proposed | none | denied, `department_inactive` |

`activeDepartmentsDenied` is empty. The allowlist was not expanded. A rejected assignment still overrides the compatibility default.

## 4. Migration review

`0011_routing_decisions` (`when` `1793553000000`) creates `routing_decisions`, five `ON DELETE restrict` foreign keys, three checks, and two partial unique indexes. The SQL does not drop, delete, update, or alter an existing table. Before activation it was the only pending journal entry. The runner also runs `CREATE EXTENSION IF NOT EXISTS vector` and recreates the existing immutability functions and triggers, including the new routing triggers. PostgreSQL reported that `vector` already existed and that the routing triggers did not exist yet, which matches a first application.

## 5. Integration harness changes

`INTEGRATION_DATABASE_URL` is required. The guard rejects ports other than `5435`, database name `ai_colony`, the canonical data-directory string, non-loopback hosts, and a missing URL even when `DATABASE_URL` is set. Global setup starts `docker-compose.integration.yml` as project `ai-colony-m101`. RabbitMQ tests require `INTEGRATION_RABBITMQ_URL` on port `5673` and refuse port `5672`. Negative tests do not open a canonical connection.

## 6. Existing regression test results

Recorded during preflight, before this activation:

| Suite | Passed | Skipped | Failed |
| --- | --- | --- | --- |
| Unit, including ledger and routing database tests | 187 | 0 | 0 |
| Integration, including isolated RabbitMQ | 51 | 0 | 0 |

Typecheck and ESLint passed. `tests/smoke/real-model.test.ts` was not run.

## 7. Canonical preflight

Immediately before the backup, a read-only session confirmed:

- Host `127.0.0.1`, port `5433`, database `ai_colony`, user `colony`
- PostgreSQL 17.5 (Homebrew)
- Data directory `/tmp/ai-colony-pg`
- 11 migration rows, latest `1793552000000`
- `routing_decisions` absent
- No active or idle-in-transaction session
- Eighteen idle pgAdmin sessions
- Checksums in section 14

## 8. Approval status

The operator approved with this exact sentence:

`APPROVE M10.1 CANONICAL ACTIVATION ON 127.0.0.1:5433 / ai_colony — MIGRATION 0011 ONLY`

The target was reverified after that sentence and before `pg_dump` and `pnpm db:migrate`.

## 9. Backup

- File: `/Users/jad/Desktop/ai-colony-backups/ai_colony-pre-m101-20261103T035108Z.dump`
- `pg_dump` exit status: 0
- Size: 621,819 bytes
- Archive entries: 621
- SHA-256: `cc6252b2fe3701638483f70d9424d26475aeadbe5ad8ac6e8d1e3cd412b87ac1`
- Format: PostgreSQL 17.5 custom format
- `pg_restore --list` succeeded and did not list a `routing_decisions` table

The archive was not restored over canonical PostgreSQL.

## 10. Isolated restore verification

`pg_restore --no-owner --no-privileges --exit-on-error` exited 0 into database `colony_m101_restore` through host `127.0.0.1:5435`. The server data directory was `/var/lib/postgresql/data` inside the disposable PostgreSQL 17 + pgvector container. The container-internal port is 5432; the published host port is 5435. Restored migration count was 11, latest timestamp `1793552000000`, and `routing_decisions` was absent. Every protected checksum in section 14 matched.

## 11. Migration execution result

`pnpm db:migrate` exited 0. `DATABASE_URL` was the canonical URL on port `5433` / `ai_colony`. The runner applied the pending migration and then refreshed immutability triggers. Notices:

- extension `vector` already exists, skipping
- schema `drizzle` already exists, skipping
- relation `__drizzle_migrations` already exists, skipping
- `routing_decisions_no_update` and `routing_decisions_no_delete` did not exist yet, so the first `DROP TRIGGER IF EXISTS` skipped

The command was not retried.

## 12. Independent post-migration verification

A new read-only connection, `transaction_read_only = on`, confirmed:

- Database `ai_colony`, port `5433`, data directory `/tmp/ai-colony-pg`
- 12 migration rows, latest `1793553000000`
- `routing_decisions` exists and contains 0 rows
- Indexes `routing_decisions_pkey`, `routing_decisions_task_unique`, `routing_decisions_objective_purpose_unique`
- Foreign keys `routing_decisions_task_fk`, `routing_decisions_objective_fk`, `routing_decisions_department_fk`, `routing_decisions_assignment_fk`, `routing_decisions_model_fk`
- Checks `routing_decisions_authorization_check`, `routing_decisions_fallback_check`, `routing_decisions_verification_check`
- Triggers `routing_decisions_no_update` and `routing_decisions_no_delete`, both `BEFORE` row triggers calling `colony_reject_training_mutation()`
- Ledger tables still exist
- Historical checksums unchanged

No synthetic routing decision was inserted. Immutability is established by the trigger definitions and function bodies, which raise on update and delete.

## 13. Routing readiness result

`pnpm routing:ready` exited 0.

- `status`: `ready`
- `readOnly`: true
- `migration0011`: `applied`
- `sharedModelRegistered`: true
- `legacyAllowlistCount`: 12
- `activeDepartmentCount`: 12
- `activeDepartmentsDenied`: empty
- Engineering: denied, `department_inactive`
- `liveInference`: `not_run`
- Detail: routing schema and the legacy department policy are present. This is not live inference readiness.

## 14. Historical data preservation

Checksum expression: `md5` of `string_agg` over the ordered identity columns. The same values were observed before the backup, in the isolated restore, and after migration `0011`.

| Table | Rows | MD5 |
| --- | --- | --- |
| departments | 13 | `59a9bd001e4498592de0a2a3e8d55e58` |
| department_model_assignments | 2 | `c0ac871016ce7c45c9fc71c4a0ecded9` |
| models | 3 | `10e66956ca060a1b764fd17b459cd419` |
| model_runtimes | 1 | `8f4d7a27e702f9a07cece6d0b66660a3` |
| evaluation_runs | 5 | `bb8b09aabdaaa8471f526bd2f85ea8af` |
| evaluation_item_results | 100 | `27683b9894ccd499efff4fdfa6793a98` |
| audit_events | 203 | `17976a7716533a2d5bb23c923461fd5c` |
| message_outbox | 42 | `345c10a5ed1bded7f25add3f6906e9a8` |
| principals | 11 | `50d998c45c2573f8d15e7d8a9f6e55eb` |
| role_permissions | 188 | `51353131294f9e46da49a3235d0f4e70` |
| ledger_topics, ledger_snapshots, ledger_proposals, ledger_decisions, ledger_retention_events | 0 | `d41d8cd98f00b204e9800998ecf8427e` |

Outbox status remains 20 pending and 22 published. Model registry status was not changed. Qwen3-8B remains `not_deployed` in the registry while the compatibility policy authorizes that specific id.

## 15. Remaining risks

- The canonical data directory is `/tmp/ai-colony-pg`. The verified backup is the durable pre-migration copy. Restoring it over canonical PostgreSQL would discard later data and needs a separate approval.
- Execution identity stays unverified until a backend supplies a digest. Readiness does not prove that Ollama will serve a request.
- Engineering remains unauthorized. Activating that department later does not grant the shared model without an explicit assignment.
- Idle pgAdmin sessions were connected and were not inside a transaction.

## 16. M11 readiness recommendation

Routing persistence and the legacy department policy are ready on canonical PostgreSQL. M11 should not start from this activation. Specialized models are not deployed, no live inference was demonstrated, and execution digests are still unverified. A later milestone needs its own scope and approval before model deployment or token generation.
