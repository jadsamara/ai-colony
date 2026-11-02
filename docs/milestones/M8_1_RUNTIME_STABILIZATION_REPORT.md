# M8.1 Runtime Stabilization Report

## 1. Executive summary

Historical model readiness is now separate from the live Ollama observation. `GET /api/v1/inference/health` and `pnpm health` report the stored `model_runtimes` row and a fresh process-memory probe side by side. The live probe uses `GET /api/version`, `GET /api/tags`, and `GET /api/ps`. It does not run inference, load a model, or write PostgreSQL.

The 20 pending outbox records are expected backlog. Each has `publish_attempts = 0` and no last error. The publisher process is stopped, so those rows were never claimed. The implemented delivery contract remains at-least-once publication with duplicate-safe consumption. No publisher behavior change was required.

The canonical database on `127.0.0.1:5433` / `ai_colony` / `/tmp/ai-colony-pg` was inspected through a session with `default_transaction_read_only=on`. Its outbox counts and update timestamps are the same after this milestone as before it. Port `5434` was not contacted.

## 2. Runtime observations versus the M8 audit

The audit is `docs/audits/M8_ARCHITECTURE_RUNTIME_AUDIT.md`. Observations below were taken on 2026-11-02 with read-only checks.

| Item | M8 audit | M8.1 observation |
|---|---|---|
| PostgreSQL | Homebrew on `127.0.0.1:5433`, data directory `/tmp/ai-colony-pg` | Same listener and `SHOW data_directory` = `/tmp/ai-colony-pg`. Inspection session reported `transaction_read_only = on`. |
| Port 5434 | Not contacted | Not contacted. The inspection factory refuses that port before connecting. |
| Ollama | Connection refused on `127.0.0.1:11434` | Listening. `GET /api/version` returned `0.40.13` both at the start of this milestone and at the final CLI run (`checked_at` `2026-11-02T20:59:50.145Z`). |
| Qwen3-8B | Stored runtime `ready`; service down | Stored row is still `ready`, probed `2026-11-01T05:14:13.861Z`, `loaded_model_id` `qwen3:8b`. Live tags include `qwen3:8b`. `GET /api/ps` returned no models. Inference readiness is `unknown`. |
| Other local models | Manifests present | Tags also include `embeddinggemma:latest`. Registry display names are Qwen3-8B, Qwen3-4B, and Gemma 3 270M. |
| API | Port 3000 not listening | Still stopped. |
| Workers | No processes; heartbeats from 2026-11-01 | Still no worker process. Newest heartbeat `2026-11-01T15:51:07.116Z`, reported `stale`. |
| Dispatcher | Stopped; 20 pending outbox rows | Publisher process absent. Still 20 pending and 22 published. |
| RabbitMQ | Listening on 5672 | TCP connect to the configured broker succeeded. No exchange, queue, or publish was issued. |
| Training | Paused | Provider `scripted`. No trainer process. Last experiment timestamp `2026-11-01T22:38:31.095Z`. State `configured`. |

The final CLI observation is the one in the table. Ollama remained reachable from the opening probe through that CLI run. This report does not assume it stays up after the CLI exited.

## 3. Root cause of stale model readiness

`ObjectiveService.recordProbe` records the result of `OpenAICompatibleProvider.probe`, which calls `GET /v1/models`. When the configured alias is in that list, the code stores `runtime_status = ready` and `loaded_model_id` equal to the alias. That list is the set of installed models. It does not mean the model is in memory, and it does not mean an inference succeeded.

`GET /api/v1/inference/health` previously returned only `listRuntimes()`. The Qwen3-8B row was written at `2026-11-01T05:14:13.861Z`. Ollama was later stopped, which the audit observed, and was later started again by the operator. Nothing rewrote the row, so `ready` survived both the outage and the restart. The last completed inference request is `2026-11-01T05:47:42.527Z`, outside the 60-second freshness window.

M8.1 leaves that write path and the stored row unchanged. Current availability comes from the separate live object.

## 4. Model health state and response contract

Live evidence is not one exclusive status.

| Property | Evidence used |
|---|---|
| Registered | Registry row for the configured primary model |
| Artifacts present | Ollama manifest file for the alias, when the path is safe to stat |
| Reachable | `GET /api/version` succeeds |
| Installed | `GET /api/tags` lists the alias |
| Loaded | `GET /api/ps` lists the alias |
| Inference ready `verified` | Reachable, loaded, and a completed inference inside the freshness window |
| Inference ready `unknown` | Service is up and no fresh successful inference is known. Loaded does not imply ready. |
| Inference ready `unavailable` | The service check failed. A stored `ready` row cannot override this. |
| Stale | The cached observation is older than the freshness window |

The response fields are `persisted_status`, `live_status`, `checked_at`, `evidence`, `inference_ready`, and `stale`.

Defaults, also in `.env.example`:

- `OLLAMA_PROBE_TIMEOUT_MS=3000` per request
- `OLLAMA_PROBE_FRESHNESS_MS=60000`
- `OLLAMA_PROBE_MIN_INTERVAL_MS=10000`

Results are cached in the process. They are not written to PostgreSQL. A repeated probe of the same target inside the minimum interval returns the cached observation and marks it stale once it is older than the freshness window. Requests are aborted at the timeout. Connection refusal, HTTP errors, malformed JSON, a missing model, an installed-but-unloaded model, and a loaded-but-unverified model each produce an explicit evidence error or an unknown/unavailable readiness value.

Ordinary health does not call `/api/generate`, `/api/chat`, `/api/embeddings`, `/api/pull`, or `/v1/chat/completions`. `ollamaProbeUrl` refuses any other path.

No deep inference probe was added. The existing `POST /api/v1/inference/probe` still performs the historical `/v1/models` write. Running it was outside this milestone because it writes the canonical runtime row.

`GET /api/v1/inference/health` and `GET /api/v1/monitoring/overview` now attach the live object. `GET /api/v1/runtime/health` returns the colony summary when the API is running. Those routes were typechecked. They were not called against the stopped production API.

## 5. Outbox investigation

Read-only grouping, confirmed again after the code changes:

| Status | Count | Publish attempts | Last error | Oldest `updated_at` | Newest `updated_at` |
|---|---:|---:|---:|---|---|
| pending | 20 | 0 | none | `2026-11-01 09:35:35.081104-05` | `2026-11-01 11:14:32.501966-05` |
| published | 22 | 1 | none | `2026-11-01 01:11:40.385-04` | `2026-11-01 01:47:12.7-04` |

Pending rows by message type: `TRAINING_REQUEST` 7, `TASK_RESULT` 4, `COLLABORATION_REQUEST` 4, `LEARNING_CYCLE_RESULT` 2, `KNOWLEDGE_VALIDATION` 1, `EVALUATION_RESULT` 1, `KNOWLEDGE_TRANSFER` 1.

Payloads were not selected. There is no `publishing` or `failed` residue and no error text. The publisher claims a row before the first attempt and increments `publish_attempts` in that claim. Zero attempts means `claimOutbox` never ran for these rows. The publisher process is absent. The pending records are the backlog left while the dispatcher was stopped, not a separate broker failure.

## 6. Actual messaging delivery guarantees

The code implements at-least-once publication. `RabbitMessageTransport` uses quorum queues, a confirm channel, mandatory publish, and `waitForConfirms`. `messages.metrics()` reports `deliveryGuarantee: "at-least-once"`. The transport comment states that this is not exactly-once.

`publishOutboxBatch` claims a batch, publishes, then calls `markPublished`. If publish throws, `schedulePublishRetry` returns the row to `pending`, or to `failed` once `publishAttempts` reaches `maxPublishAttempts` (default 8). Delay comes from `retryDelayMs`: exponential backoff from `retryBaseMs` (default 1000) capped at `retryMaxDelayMs` (default 60000), plus up to 20 percent jitter. A failed publish does not delete the row.

Consumers are duplicate-safe. `processInbound` acknowledges a second delivery when the message is already `expired` or `dead_lettered`, and when the processing lease is not acquired. `send` returns the original row when the same idempotency key and payload hash are presented again. That is safe duplication handling, not exactly-once processing.

No production queue was replayed and the publisher was not started.

## 7. Source files and functions changed

New:

- `packages/inference/src/ollama-status.ts`: `OllamaStatusClient.inspect`, `ollamaProbeUrl`
- `packages/core/src/runtime/model-health.ts`: `describeModelHealth`, `inferenceReadiness`, `artifactPresence`
- `packages/core/src/runtime/colony-health.ts`: `buildRuntimeReport` and the component assessors
- `packages/core/src/runtime/local-signals.ts`: `tcpReachable`, `commandLines`, `processSeen`
- `packages/core/src/messaging/outbox-summary.ts`: `summarizeOutbox`
- `packages/database/src/inspection.ts`: `createReadOnlyInspection`, `assertReadOnlyInspectionUrl`, `assertDisposableDatabaseUrl`
- `apps/api/src/routes/live-model.ts`: `currentModelHealth`
- `apps/api/src/routes/runtime-health.ts`: `GET /api/v1/runtime/health`
- `apps/api/src/runtime-health-cli.ts`: `pnpm health`
- `tests/unit/runtime-health.test.ts`
- `tests/unit/colony-health.test.ts`
- `tests/unit/outbox-reliability.test.ts`
- `tests/unit/database-guard.test.ts`

Extended:

- `packages/contracts/src/schemas/objective.ts`: `liveModelHealthSchema`, optional `live` on inference health and monitoring overview, `colonyHealthSchema`
- `packages/inference/src/config.ts`: probe timeout, freshness, and minimum interval
- `packages/core/src/objectives/objective-service.ts`: `latestCompletedInferenceAt`, `runtimeEvidence`. `recordProbe` is unchanged except for a comment that the stored status is historical.
- `packages/database/src/repositories/objectives.ts`: `latestCompletedInferenceAt` (SELECT)
- `apps/api/src/routes/objectives.ts`: live object on the existing health and overview responses
- `.env.example`, `package.json` (`health` script)

The publisher, consumer, and RabbitMQ transport were not modified.

## 8. Tests executed and results

Unit suite: `pnpm exec vitest run --config vitest.unit.config.ts`

- 23 files, 113 tests passed, 0 failed, 0 skipped

That includes the new cases for unreachable Ollama, installed versus loaded, unknown inference readiness, persisted `ready` beside a failed live check, bounded timeout, malformed JSON, HTTP 503, stale cached evidence, the three-GET allow list, stopped dispatcher, publisher failure without dropping the record, retry delay, permanent failure at the configured attempt limit, duplicate acknowledgement, idempotency replay, unknown workers, and partial infrastructure.

`tsc -p tsconfig.typecheck.json --noEmit` passed. ESLint passed on the M8.1 files.

Integration tests were not run. `tests/global-setup.ts` connects using `DATABASE_URL`, whose default is port `5433` and database `ai_colony`, and it can run `docker compose up`. A disposable cluster on port `5435` was not created. The write guard that rejects ports `5433` and `5434` and the database name `ai_colony` is unit-tested and was not pointed at a live server.

`pnpm health` was run against the operator machine. It is the runtime-verified health path. The Fastify routes were not started.

## 9. Migrations

None written. None applied. The persisted `runtime_status` enum was not changed.

## 10. Remaining operational limitations

- The stored Qwen3-8B row still says `ready`. That is historical. Live health is the current view.
- `POST /api/v1/inference/probe` still writes `ready` from `GET /v1/models`. It was not invoked.
- Monitoring findings still treat persisted `unavailable` or `failed` as the model alert. A stored `ready` row does not by itself raise a finding when Ollama is down. The live object attached to the overview is the current observation.
- Worker and dispatcher state use heartbeats and process command lines. There is no new heartbeat table. A host where `ps` fails is reported `unknown` when no heartbeat exists.
- RabbitMQ health is a TCP connect. It does not declare topology and does not prove that a consumer is alive.
- The API route was not executed, because starting the API was out of scope. The CLI covers the stopped-API case.
- The canonical data directory remains `/tmp/ai-colony-pg`.
- Evaluation comparability, assignment-aware routing, and adapter routing were not part of this milestone.

## 11. Canonical outbox before and after

Both reads used `BEGIN READ ONLY` and observed `transaction_read_only = on`.

Before implementation and after the final health command, the grouped result was identical:

- pending: 20, attempts 0–0, no errors, updates `2026-11-01 09:35:35.081104-05` through `2026-11-01 11:14:32.501966-05`
- published: 22, attempts 1–1, no errors, updates `2026-11-01 01:11:40.385-04` through `2026-11-01 01:47:12.7-04`

## 12. PostgreSQL on 5433

The canonical database was not modified. Inspection used a one-connection client with `default_transaction_read_only=on`, verified with `SHOW transaction_read_only`, and issued SELECT and SHOW statements only. `SHOW data_directory` remained `/tmp/ai-colony-pg`. No migration, seed, runtime update, audit insert, or outbox update was run.

## 13. PostgreSQL on 5434

No connection was opened to port 5434. The Docker container, its volumes, and its configuration were not changed. `assertReadOnlyInspectionUrl` throws if a caller passes port 5434.

## 14. Models, training, and deployment

M8.1 did not train, load, unload, download, or replace a model. It did not promote an adapter. It did not run `/api/generate`, `/api/chat`, `/api/embeddings`, or `/api/pull`. It did not deploy to GCP. The live Ollama calls were the three GET probes above. Training artifacts and evaluation history were not modified.

## 15. Readiness for M8.2

M8.1 is complete for its health and messaging scope. The completion checks in the milestone are backed by the unit tests, the read-only snapshots, and the CLI output above. M8.2 was not started.

The durable location of `/tmp/ai-colony-pg`, evaluation-run comparability, and model routing remain open from the M8 audit. They are outside M8.1.
