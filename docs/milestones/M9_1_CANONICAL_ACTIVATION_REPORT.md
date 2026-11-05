# M9.1 Canonical Activation Report

Status: **ACTIVATED AND VERIFIED** on 2 November 2026.

The operator approved the sequence with:

**APPROVE M9.1 CANONICAL ACTIVATION ON 127.0.0.1:5433 / ai_colony — MIGRATIONS 0009 AND 0010 ONLY**

No inference, training, API start, worker start, or RabbitMQ replay was performed. Port 5434 was not contacted.

## 1. Git state

- Branch: `m9.1-ledger-activation`
- Commit: `e51e4f42e0d14255485764660c52eeeb10985071`
- No migration file was rewritten.

## 2. Verified database identity

Revalidated immediately before the backup and again immediately before migration.

| Check | Observed |
| --- | --- |
| Database | `ai_colony` |
| User | `colony` |
| Server address | `127.0.0.1` |
| Port | `5433` |
| Data directory | `/tmp/ai-colony-pg` |
| Server and `pg_dump` | PostgreSQL 17.5 |
| Read-only inspection | `transaction_read_only = on` |

`DATABASE_URL` pointed at that same host, port, and database. The password was not recorded.

## 3. Migration allowlist

Before execution, `drizzle.__drizzle_migrations` contained nine rows, latest `created_at` `1793549300000` (`0008_training_experiments`). No `ledger_%` relation existed.

The only newer journal entries were:

| Tag | `created_at` recorded |
| --- | --- |
| `0009_department_capability_ledger` | `1793551000000` |
| `0010_ledger_measurement_proposals` | `1793552000000` |

After execution those are rows 10 and 11. No other timestamp was added.

`migrateDatabase` also ran `CREATE EXTENSION IF NOT EXISTS vector`, which reported that `vector` already existed, and then refreshed the existing immutability triggers in a second transaction. Those steps do not add migration-history rows and did not change table contents.

## 4. Pre-activation baseline

| Object | Count | Checksum |
| --- | --- | --- |
| `evaluation_runs` | 5 | `eee211d51684bd6511ae2dccde90728d` |
| `evaluation_item_results` | 100 | `3d43025d5176528eb6ab4a5af4bf0638` |
| `departments` | 13 | `ed8479bea4ce2bf69f2b245c2f570cc7` |
| `principals` | 11 | `6bb97c25f139e79f80889eea2c4d3284` |
| `role_permissions` | 188 | `58e4f559e0087fbad2c5877f071d085d` |
| `audit_events` | 203 | `34f37af8820c1088cd8ed1d476a284de` |
| `department_model_assignments` | 2 | `d25f46a4cf417fbf16994b0d6cade376` |
| `models` | 3 | `322f0ddee7526f45036315b2f56a0308` |
| `model_runtimes` | 1 | `c9f7d4251de768f1339d554ad4de5b49` |
| `message_outbox` | 42 | `eb18fe2478bac4deb993d64257f283a1` |

Outbox: 20 pending, 22 published. Public base tables before activation: 83.

## 5. Backup

- Path: `/Users/jad/Desktop/ai-colony-backups/ai_colony-pre-m91-20261103T025421Z.dump`
- Started: `2026-11-03T02:54:21.768037Z`
- Size: 584,657 bytes
- SHA-256: `90012bff0bdf50a40d0e18fecb72c1ac4b93dc97264efec89f2e43498a281b50`
- `pg_dump` exit status: 0
- `pg_restore --list` exit status: 0, 544 archive entries

The file is outside `/tmp/ai-colony-pg`.

## 6. Isolated restore

`pg_restore --list` was not treated as proof of restorability. The archive was restored with `pg_restore` exit status 0 into disposable database `colony_restore_m91` on container `ai-colony-m91-restore`.

The image was `pgvector/pgvector:pg17`, published only as `127.0.0.1:5435`. Plain `postgres:17` was not used because the canonical database requires the `vector` extension and the only local PostgreSQL images were version 16. The container was removed after the comparison. `ai-colony-postgres` on port 5434 was left running and was not queried.

Restored counts and checksums matched the baseline for evaluation runs, item results, departments, outbox, audit events, and model assignments. The restored migration table had 9 rows. The restored database had no ledger relations. Outbox status counts were 20 pending and 22 published.

## 7. Migration execution

Command: `pnpm db:migrate`

- Started: `2026-11-03T02:55:08.152163Z`
- Finished: `2026-11-03T02:55:10.569751Z`
- Exit status: 0
- Printed: `Migrations applied`

Notices: `vector`, the `drizzle` schema, and `__drizzle_migrations` already existed. Four new foreign-key names were truncated to PostgreSQL's 63-character identifier limit. The initial `DROP TRIGGER IF EXISTS` for the new ledger tables reported that those triggers did not yet exist. No error was raised. The command was not retried.

## 8. Post-activation schema

Independent read-only inspection, after the command exited:

- Port `5433`, data directory `/tmp/ai-colony-pg`, `transaction_read_only = on`.
- Migration rows `1793551000000` and `1793552000000` are present. History is 11 rows.
- All ten ledger tables exist.
- All twenty `ledger_%_no_update` and `ledger_%_no_delete` triggers exist.
- Functions `colony_reject_audit_mutation`, `colony_reject_published_benchmark`, and `colony_reject_training_mutation` exist.
- `ledger_proposals_kind_check` allows `taxonomy`, `mapping`, and `measurement`.
- 21 ledger foreign keys exist.
- Ledger topic, proposal, snapshot, decision, and retention tables contain 0 rows.
- Public base tables: 93, which is the previous 83 plus the 10 ledger tables.

## 9. Historical data

Every baseline checksum and count matched after activation, including the five evaluation runs, 100 item results, 13 departments, 203 audit events, 42 outbox rows, 2 model assignments, 3 models, and 1 runtime row. Outbox status remained 20 pending and 22 published. No adapter promotion was performed.

## 10. Readiness

`pnpm ledger:ready` reported:

- `status`: `operational`
- `database`: `connected`
- `readOnly`: `true`
- `port`: `5433`
- `dataDirectory`: `/tmp/ai-colony-pg`
- `missingMigrations`: empty
- `tablesMissing`: empty
- `triggersMissing`: empty
- `certificationAuthority`: `demonstrated`
- `governancePath`: `demonstrated`
- `evaluationContract`: `m8.2-evaluation-contract-v1`
- `apiRunning`: `not_checked`

The ledger schema is installed. No capability snapshot has been certified.

## 11. Remaining risks

- Four foreign-key identifiers are stored in truncated form. The constraints are present. Future migrations should keep new constraint names within 63 characters.
- `apiRunning` was not checked. The API was intentionally left stopped.
- Eighteen idle pgAdmin sessions were connected during preflight. They did not block activation.
- Restoring the backup over `ai_colony` would discard this activation and any later writes. That restore was not performed and still requires a separate approval.
- Certification remains a later operator action. The Evaluation department agent still cannot certify.

## 12. M10

The ledger deployment gate is cleared: migrations 0009 and 0010 are applied and verified on canonical PostgreSQL. M10 was not started. Serving still does not follow department model assignments, a ledger comparison still does not authorize deployment, and the historical evaluation rows were not turned into certified capability evidence.
