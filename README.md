# AI Colony V1

Milestone 1 is the colony control plane: a department registry, a universal agent record, a lifecycle runtime, a model metadata registry, deterministic authorization, budget definitions, and append-only audit logging.

Milestone 2 adds IACP 1.0, the inter-agent communication protocol. Agents send versioned messages through a PostgreSQL transactional outbox. A publisher confirms them to RabbitMQ, and a consumer records receipt. Messaging does not grant authority: a training request does not start training, a resource request does not change a budget, and an evolution proposal does not create a department.

Milestone 3 adds LangGraph.js workflows for the CEO, Orchestration, and Monitoring, plus an OpenAI-compatible inference adapter. RabbitMQ still carries task requests and results. PostgreSQL still stores the objective, the outbox, and the LangGraph checkpoints. A model cannot grant permissions, change a budget, create a department, or mark itself ready.

This process does not run language models, download weights, train networks, or spend cloud GPU time. A stored budget is a validated limit inside the control plane. It does not cap real cloud billing. An agent status of `running` means a lifecycle executor in this process was started. It does not mean the agent is reasoning or learning.

## Requirements

- Node.js 22
- pnpm 10.18.2 (`corepack enable && corepack prepare pnpm@10.18.2 --activate`)
- Docker Desktop, for the PostgreSQL 16 and RabbitMQ 4 containers

The repository includes `.nvmrc` with `22`. On an Apple Silicon Mac:

```bash
nvm use
corepack enable
pnpm install
```

No Google Cloud project, GPU, or model credentials are required.

## Database

Compose publishes PostgreSQL on host port **5433** so it does not collide with a PostgreSQL already listening on 5432.

```bash
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

`pnpm db:up` starts PostgreSQL 16 as `ai-colony-postgres` and RabbitMQ 4 as `ai-colony-rabbitmq` on the `ai-colony` network. The database, user, and password are `ai_colony` / `colony` / `colony`. The first container start also creates `ai_colony_test` for integration tests. RabbitMQ listens on `127.0.0.1:5672`. Its management UI is [http://127.0.0.1:15672](http://127.0.0.1:15672) with user `colony` and password `colony-dev-password`. That UI is bound to localhost. Do not publish it on a public interface or deploy this broker to Cloud Run.

`pnpm db:migrate` compiles the packages and applies `packages/database/src/migrations` with drizzle-kit's migrator, then installs the audit immutability triggers. Generate a new migration with `pnpm db:generate` after a schema change. Do not push schema changes without a migration file.

`pnpm db:seed` is idempotent. It inserts the twelve founding departments and three model metadata rows only when those ids are absent, and it rewrites the role-permission mirror from the compiled permission matrix. Running it again does not reset a department status or a model status that you changed later. It does restore the bootstrap principal to `system_administrator`.

Stop the database with `pnpm db:down`. That keeps the Docker volume. `docker compose down -v` deletes it.

## API

```bash
pnpm dev
```

`pnpm dev` compiles the project and reloads `apps/api/src/server.ts`. `pnpm start` runs the compiled `apps/api/dist/server.js`. The process listens on `PORT` (default 3000) and `HOST` (default `0.0.0.0`), logs JSON to stdout, and closes the HTTP server and database pool on `SIGINT` or `SIGTERM`.

OpenAPI UI is at [http://localhost:3000/docs](http://localhost:3000/docs). The document is `GET /api/v1/openapi.json`.

### Authentication

`AUTH_MODE` defaults to `disabled`. In that mode every route except health, readiness, and documentation returns 401. There is no endpoint that grants administrator privileges.

Local development uses `AUTH_MODE=development`, which is already set in `.env.example`. Send the principal id as a bearer token:

```bash
Authorization: Bearer 00000000-0000-4000-8000-000000000001
```

That UUID is the seeded system administrator. The process refuses to start when `NODE_ENV=production` and `AUTH_MODE=development`.

The permission matrix in `packages/core/src/governance/permissions.ts` is the authorization source. The database role tables are a mirror for inspection. A CEO agent is not a system administrator and cannot approve permanent departments. Agents cannot change their own role, their own permissions, their own budget, or their own department budget.

### Example requests

```bash
curl -s http://localhost:3000/api/v1/health

curl -s http://localhost:3000/api/v1/departments \
  -H "Authorization: Bearer 00000000-0000-4000-8000-000000000001"

curl -s http://localhost:3000/api/v1/departments \
  -H "Authorization: Bearer 00000000-0000-4000-8000-000000000001" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Engineering",
    "slug": "engineering",
    "description": "Builds and operates colony software.",
    "purpose": "Implement approved engineering work.",
    "departmentType": "specialized",
    "resourceBudget": {
      "maxConcurrentExecutions": 2,
      "maxCpuAllocation": { "value": 1000, "unit": "millicores" },
      "maxGpuAllocation": { "value": 0, "unit": "devices" },
      "maxMemoryAllocation": { "value": 2048, "unit": "mebibytes" },
      "maxEstimatedComputeExpenditure": { "value": 0, "unit": "usd_micros" },
      "maxTrainingExpenditure": { "value": 0, "unit": "usd_micros" },
      "maxModelParameterCount": { "value": 0, "unit": "parameters" },
      "resetPeriod": null,
      "expiresAt": null
    }
  }'
```

A created department is `proposed`. Permanent types (`system`, `specialized`, `experimental`) become `provisioning` only when a system administrator approves a `department_create` request, then `active` only when that administrator approves a `department_activate` request. `temporary` departments can be approved by a principal that holds `approval:decide`, including a CEO agent, and that principal still cannot approve their own request. `POST /api/v1/departments/:id/activate` resumes a paused department. Calling it while the department is `provisioning` returns `APPROVAL_REQUIRED`.

List responses use cursor pagination: `limit` (default 20, maximum 100) and an opaque `cursor`. The page object is `{ limit, nextCursor, hasMore }`.

Errors use `{ "error": { "code", "message", "details", "correlationId" } }`. Send `X-Correlation-Id` to set the id.

## Department lifecycle

| From         | Allowed next statuses          |
| ------------ | ------------------------------ |
| proposed     | provisioning, failed, archived |
| provisioning | active, failed, archived       |
| active       | paused, deprecated, archived   |
| paused       | active, deprecated, archived   |
| deprecated   | archived                       |
| failed       | archived                       |
| archived     | none                           |

`proposed -> provisioning` and `provisioning -> active` happen inside an approval decision, not through the activate route. Archive is rejected while a child department is still unarchived. Creating a parent link that would cycle the hierarchy is rejected. Department type and slug stay fixed after creation.

Seeded founding departments, all `system` and `active`: CEO, Orchestration, Monitoring, Evolution, Weight Optimization, Memory & Forgetting, Evaluation, Research, Math, Reasoning, Science, and Gaming. New departments such as Engineering use the same table and need no schema change.

## Agent lifecycle

| From         | Allowed next statuses     |
| ------------ | ------------------------- |
| registered   | initializing, archived    |
| initializing | idle, failed              |
| idle         | running, paused, archived |
| running      | idle, stopping, failed    |
| paused       | idle, archived            |
| stopping     | stopped, failed           |
| stopped      | initializing, archived    |
| failed       | initializing, archived    |
| archived     | none                      |

`failed -> initializing` requires `{ "authorizeRetry": true }` on `POST /api/v1/agents/:id/retry`. Any other caller receives `RETRY_NOT_AUTHORIZED`.

`POST /start` moves `idle -> running` only when this process has a `lifecycle-only` executor attached. Otherwise the status stays `idle` and the response is `EXECUTOR_NOT_ATTACHED`. The executor reports `inference: false`, `learning: false`, and `training: false`. Changing the database status by hand does not make `activelyExecuting` true.

On startup the API reconciles stale transitional rows whose heartbeat is missing or older than `RUNTIME_STALE_AFTER_MS` (default 30000): `initializing -> failed`, `running -> idle`, `stopping -> stopped`. A fresh heartbeat owned by another process is left alone, and this process does not report that agent as locally executing. Shutdown moves agents this process is executing through `stopping` to `stopped`.

Agents can be registered only in an `active` department. Agent budgets must be within the department budget, and the parameter budget must match the compute budget's parameter count. Changing a budget after creation requires a `budget_change` approval.

## Messaging

Start the API, then the two workers in separate terminals. Both read `DATABASE_URL` and `RABBITMQ_URL` from `.env`.

```bash
pnpm dev
pnpm dev:publisher
pnpm dev:consumer
```

`pnpm start:publisher` and `pnpm start:consumer` run the compiled workers. Stop each process with Ctrl-C or SIGTERM. The publisher finishes its current batch and closes the broker connection. The consumer finishes in-flight deliveries before it closes.

An agent publishes only as itself. The bearer token is the sender. A body field that names another agent is rejected. The sender and the recipient department must be `active`, and the sender agent must be `idle`, `running`, or `paused`.

```bash
curl -s http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <sender-principal-uuid>" \
  -H "Content-Type: application/json" \
  -d '{
    "messageType": "TASK_REQUEST",
    "recipientAgentId": "<recipient-agent-uuid>",
    "idempotencyKey": "task-demo-0001",
    "payload": {
      "taskId": "00000000-0000-4000-8000-0000000000aa",
      "objective": "Record this request",
      "constraints": ["Do not infer"],
      "expectedOutput": "A stored receipt",
      "deadline": null,
      "contextReferences": []
    }
  }'
```

Department inbox messages set `recipientDepartmentId` and omit `recipientAgentId`. Repeating the same idempotency key and payload returns the original message. A different payload for that key returns 409.

The publisher claims pending outbox rows with `FOR UPDATE SKIP LOCKED`, sends persistent messages, and waits for a publisher confirm before marking the row published. The consumer acknowledges RabbitMQ only after the processing row commits. Duplicate deliveries see that row and do not run the handler again. This is at-least-once delivery. It is not exactly-once execution, and a future external side effect must be idempotent on `messageId`.

Quorum queues survive a broker restart. They do not remove every failure mode: a confirm can succeed before the database update, and a consumer can commit before its ack reaches RabbitMQ. Both cases are safe because the message id is stable and the inbox record is unique.

Retries use bounded exponential backoff with jitter, scheduled in PostgreSQL and republished. The consumer does not nack a message straight back onto the head of the queue. After the attempt limit, or when the payload is invalid or expired, the message is dead-lettered in PostgreSQL and the broker dead-letter exchange receives deliveries that are rejected without requeue. Expired messages are recorded and not handled. `GET /api/v1/dead-letters` and `POST /api/v1/dead-letters/:id/redrive` require authorization. A redrive inserts a new outbox row. It does not grant new permissions.

Department queues are named `iacp.inbox.department.<department-id>` and bound to `department.<department-id>` plus `agent.<agent-id>` for each agent in that department. One queue per department keeps the broker small. The consumer checks the routing key against the envelope before it records receipt, so an agent-addressed message is not applied to a different agent. Archiving a department deletes its queue. Archiving an agent removes its binding. RabbitMQ still drops messages published before the binding exists; the publisher creates the queue and binding before it confirms.

Supported message types are `TASK_REQUEST`, `TASK_RESULT`, `COLLABORATION_REQUEST`, `KNOWLEDGE_SHARE`, `TRAINING_REQUEST`, `MODEL_CANDIDATE`, `EVALUATION_RESULT`, `RESOURCE_REQUEST`, `HEALTH_ALERT`, and `EVOLUTION_PROPOSAL`.

`GET /api/v1/messaging/metrics` is limited to the system administrator and reports outbox, processing, and dead-letter counts from PostgreSQL. Workers also write JSON logs with correlation ids. Payloads are not logged.

## Objectives and inference

The development machine target is an Apple Silicon Mac with 24 GB unified memory. The default profile loads one model and allows one in-flight inference request. Qwen3-8B is the primary model for the CEO, Math, Science, Research, and Reasoning. Orchestration and Monitoring are intended to use Qwen3-4B when `INFERENCE_MEMORY_PROFILE=split` and a second endpoint is configured. In the default `shared` profile every role calls the one loaded model. Usage records the served model id. The Qwen3-4B and Gemma 3 270M registry rows stay `not_deployed` until their own endpoint is probed. Gemma 3 270M is registered only. This milestone does not require it and does not train anything.

The adapter speaks to `INFERENCE_BASE_URL` with `/v1/chat/completions` and `/v1/models`. It does not call OpenAI and does not fall back to another host. A response whose `model` field differs from `INFERENCE_MODEL_ALIAS` is rejected. Token counts are `observed` only when the server returns them. Otherwise they are `unavailable`. Estimated cost is stored only when `INFERENCE_INPUT_USD_PER_MILLION` and `INFERENCE_OUTPUT_USD_PER_MILLION` are set. Those rates are not a cloud bill.

Local serving uses the existing Ollama install. Qwen3 thinks by default, and Ollama's OpenAI endpoint ignores a `think` flag. The adapter sends `reasoning_effort: "none"` so the answer is returned in `content` and the output budget is not spent on a reasoning trace. A server that rejects that field is retried without it. The alias must be the id from `/v1/models`. On this machine that id is `qwen3:8b`.

```bash
ollama serve
curl -s http://127.0.0.1:11434/v1/models
```

Do not pull another model when `qwen3:8b` is already listed. Then start the colony:

```bash
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm dev:publisher
pnpm dev:ceo
pnpm dev:orchestration
pnpm dev:specialists
pnpm dev:monitoring
```

Do not run `pnpm dev:consumer` at the same time as the orchestration and specialist workers. They share department queues. The publisher must stay up, because workers write the outbox and do not talk to RabbitMQ directly.

Seed creates one idle agent for the CEO, Orchestration, Monitoring, Math, Science, Research, and Reasoning departments. Submit an objective as the system administrator:

```bash
curl -s http://localhost:3000/api/v1/objectives \
  -H "Authorization: Bearer 00000000-0000-4000-8000-000000000001" \
  -H "Content-Type: application/json" \
  -d '{"objective":"Compare solar and wind energy for powering a small remote research station. Calculate a simple illustrative energy requirement and identify important engineering tradeoffs."}'
```

Read it back with `GET /api/v1/objectives/:id`, the tasks with `GET /api/v1/objectives/:id/tasks`, and the colony health with `GET /api/v1/monitoring/overview`. Probe the local server with `POST /api/v1/inference/probe`. A failed probe records `unavailable` or `failed` and does not change the registry row to `available`.

`pnpm test:smoke` calls the configured server only when `RUN_REAL_INFERENCE=1`. The default test suite uses a scripted provider and does not download weights.

Stop the workers with Ctrl-C. They finish the current graph step or in-flight delivery before closing the database and the checkpoint pool.

## Model registry

Seeded metadata, status `not_deployed`, no artifact URI, deployment target `none`:

- Qwen3-8B
- Qwen3-4B
- Gemma 3 270M

`POST /api/v1/models/:id/versions` inserts a new row. The previous version remains. Status updates are the only in-place model mutation. Nothing in this milestone downloads a model or calls a provider.

## Audit

Mutations of departments, agents, lifecycles, roles, budgets, models, and approvals append an `audit_events` row in the same database transaction as the change. PostgreSQL triggers reject `UPDATE` and `DELETE` on that table. Normal API roles have no update or delete route for audit rows.

Those triggers live in the same database as the data. A database superuser can disable them. This application-level append-only log is not independently tamper-proof storage.

## Scripts

| Script                        | Purpose                                           |
| ----------------------------- | ------------------------------------------------- |
| `pnpm dev`                    | Compile and run the API with reload               |
| `pnpm dev:publisher`          | Run the outbox publisher with reload              |
| `pnpm dev:consumer`           | Run the generic message consumer with reload      |
| `pnpm dev:ceo`                | Run the CEO LangGraph worker                      |
| `pnpm dev:orchestration`      | Schedule tasks and consume orchestration results  |
| `pnpm dev:specialists`        | Consume specialist tasks and call inference       |
| `pnpm dev:monitoring`         | Record health findings and alerts                 |
| `pnpm start`                  | Run the compiled API                              |
| `pnpm start:publisher`        | Run the compiled outbox publisher                 |
| `pnpm start:consumer`         | Run the compiled message consumer                 |
| `pnpm start:ceo`              | Run the compiled CEO worker                       |
| `pnpm start:orchestration`    | Run the compiled orchestration worker             |
| `pnpm start:specialists`      | Run the compiled specialist worker                |
| `pnpm start:monitoring`       | Run the compiled monitoring worker                |
| `pnpm build`                  | TypeScript project build                          |
| `pnpm typecheck`              | Strict check of the app, packages, and tests      |
| `pnpm lint`                   | ESLint                                            |
| `pnpm format`                 | Prettier                                          |
| `pnpm test`                   | Unit tests, then PostgreSQL integration tests     |
| `pnpm test:smoke`             | Optional real-model call. Requires `RUN_REAL_INFERENCE=1` |
| `pnpm db:up` / `pnpm db:down` | Start or stop PostgreSQL and RabbitMQ             |
| `pnpm db:generate`            | Write a Drizzle migration from the schema         |
| `pnpm db:migrate`             | Apply migrations and audit triggers               |
| `pnpm db:seed`                | Idempotent departments, roles, and model metadata |

## Layout

```text
apps/api/            Fastify HTTP API
packages/contracts/  Zod request and response contracts
packages/core/       Departments, agents, governance, budgets, runtime
packages/database/   Drizzle schema, repositories, migrations, seed
packages/messaging/  RabbitMQ transport, outbox publisher, consumer
packages/inference/  OpenAI-compatible inference adapter
packages/workflows/  LangGraph CEO, orchestration, and monitoring workers
services/inference/  Boundary notes for a future worker
services/training/   Boundary notes for a future worker
tests/unit/          Pure tests
tests/integration/   Tests against PostgreSQL
```

`packages/core` does not import `packages/database`. The API process is the composition root.

## Cloud Run

The HTTP process is stateless. Configuration comes from the environment, logs are JSON, `/health` and `/ready` exist at the root and under `/api/v1`, and the Dockerfile uses Node 22, `PORT=8080`, and `AUTH_MODE=disabled`. It does not pin a Google Cloud project or a GPU. Do not deploy from this milestone.

Set `DATABASE_URL` to a PostgreSQL instance the service can reach. Run the publisher, CEO, orchestration, specialist, and monitoring processes separately. Point `RABBITMQ_URL` at a broker outside Cloud Run and `INFERENCE_BASE_URL` at an OpenAI-compatible server you operate. Use TLS and a secret manager for those URLs in a real environment. Do not put either URL in a model prompt. The image still needs a real authentication mechanism before it is exposed. `AUTH_MODE=disabled` fail-closes the API: every route except health, readiness, and documentation returns 401. Development bearer tokens cannot be turned on when `NODE_ENV=production`.

## Troubleshooting

- `pnpm` or `tsc` reports a Node version error. Run `nvm use` so Node is 22.
- Port 5432 is already taken. Compose uses 5433. `DATABASE_URL` in `.env.example` matches that port.
- `docker compose up` cannot connect to the daemon. Start Docker Desktop and wait until `docker info` succeeds, then run `pnpm db:up` again.
- Migration files are missing. Run `pnpm db:generate` only if you changed `packages/database/src/schema`. The Milestone 1 migration is already in `packages/database/src/migrations`.
- Authenticated routes return 401. Set `AUTH_MODE=development` in `.env` for local use, and send the bootstrap principal UUID. With `AUTH_MODE=disabled`, that header is ignored.
- The API exits immediately with `AUTH_MODE=development cannot be used when NODE_ENV=production`.
- Integration tests need the database from `pnpm db:up`. They create and migrate `ai_colony_test`, then truncate it between tests. The RabbitMQ routing test needs the broker from the same Compose file. If `RABBITMQ_URL` is unreachable, that test is skipped and the PostgreSQL messaging tests still run.
- The management UI rejects `guest`. Use `colony` / `colony-dev-password` from `.env.example`.
- A message stays `accepted` until the publisher is running. For ordinary IACP traffic, start `pnpm dev:publisher` and `pnpm dev:consumer`. For objectives, start `pnpm dev:publisher`, `pnpm dev:ceo`, `pnpm dev:orchestration`, and `pnpm dev:specialists` instead of the generic consumer.
- `POST /api/v1/inference/probe` reports the live server. A connection error is an `unavailable` runtime status, not a successful inference.
- `pnpm test:smoke` does nothing useful until `RUN_REAL_INFERENCE=1` and Ollama is serving the configured alias at `INFERENCE_BASE_URL`.
