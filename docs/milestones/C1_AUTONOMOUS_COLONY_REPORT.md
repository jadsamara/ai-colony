# C1 Autonomous colony

Branch: `e1-e2-efficiency`. This change sits on the E1–E2 routing and performance work. Autonomous execution is disabled until an administrator enables it. No Google Cloud deploy was run, and no live GPU inference was executed.

## Existing architecture

The colony already had twelve department agents, deny-by-default permissions, append-only audit, IACP messages on RabbitMQ, objective lifecycle, and the E1–E2 router.

Reusable pieces:

- `objective:submit` and `objective:execute` stay with the system administrator. `ceo_agent` has neither, and it does not receive `autonomy:manage`.
- `MessagingService.send` already delivers across departments without transferring the recipient's permissions. Message types, idempotency, correlation, causation, and reply links already exist.
- Objective runs already track status, inference budgets, and duration. E1–E2 still chooses `direct`, `lightweight`, or `full` before a CEO planning call.
- Memory remains department-scoped. Dialogue does not write memory rows.
- The postgres.js pool stays `max: 3`.

What was missing: a stored autonomy switch, a CEO goal record that cannot be replaced by another department, a persisted multi-turn transcript, and read APIs for those records.

## Implemented functionality

An administrator can enable, pause, resume, and cancel autonomous work. A goal-generation cycle runs only when that administrator calls it. The cycle asks the configured model, acting under a CEO prompt, for at most one colony-wide goal. The goal becomes an ordinary objective with `origin: autonomous`. Human objectives keep `origin: human` and are sorted ahead of autonomous work when the scheduler has to choose.

A department agent can record a subgoal inside an open objective. The subgoal is not a new colony objective, and it cannot copy the objective text.

Two active departments can open a `DEPARTMENT_DIALOGUE` conversation. Each turn is a model response, stored as an IACP message and as a transcript row. Kinds are `question`, `response`, `proposal`, `challenge`, `evidence`, `counterargument`, `agreement`, `disagreement`, `resolution`, and `close`. `resolution` closes the conversation as resolved. `close` closes it as unresolved. Limits and inactivity close it as terminated.

## CEO goal generation

`AutonomyService.runCycle` is the only path that creates a colony goal.

It returns without a model call when autonomy is disabled, paused, inside the cooldown, over the inference budget, or already at the active-goal cap. The default row is `enabled: false`, interval 24 hours, cooldown 1 hour, one active goal, one selection inference, 30 minutes max duration, four open conversations, 12 messages, and 4,000 conversation tokens.

When a cycle is allowed, the prompt contains only observation lines: completed, failed, and active objective counts, selected goals, open conversations, stored memory count, and the text of recent failed objectives and active goals. Evidence must be `observed: ` plus one of those lines. A hypothesis is a separate field. Invented evidence is rejected and stored on `colony_goal_cycles` with the redacted prompt and the model text. Duplicate normalized descriptions are not selected again.

The selected goal stores description, motivation, evidence, hypotheses, expected benefit, success criteria, estimated inference requests, departments, priority, and stop conditions. The linked objective uses the normal lifecycle, audit, and E1–E2 router.

There is no always-on loop. `POST /api/v1/autonomy/cycles` performs one cycle. The interval and cooldown are checked at call time.

The cycle runs as the system administrator because that role holds `autonomy:manage` and `objective:submit`. The model prompt is the CEO. The `ceo_agent` role still cannot enable autonomy, submit an objective, or grant itself permissions.

## Department autonomy

Departments may:

- Add a subgoal with `message:publish` while the parent objective is open.
- Open or continue a dialogue with another active department.
- Disagree, challenge, or close without a CEO inference.
- Be denied when they are not a participant.

Departments may not:

- Submit an objective. That permission is absent from `department_agent` and `ceo_agent`.
- Call the goal cycle. `autonomy:manage` is administrator-only.
- Replace the parent objective text with a subgoal.
- Speak in a conversation they did not join.
- Change governance, create a department, or disable audit. Those permissions are unchanged.

A conversation in this slice has two participants: the opener and one recipient. A third department is denied. Adding a participant is unfinished.

Routine dialogue does not ask the CEO to approve each turn. The message still goes through the existing sender, recipient, and payload checks.

## Conversation protocol

`DEPARTMENT_DIALOGUE` was added to the message-type check. The payload is `conversationId`, `kind`, `topic`, `body`, `objectiveId`, and `parentMessageId`. The IACP envelope keeps sender department, recipient department, correlation id, causation id, reply id, and timestamp.

The model sees the topic, the requested speech act, and the prior transcript. It is told to write only the message body. The stored prompt is redacted for database URLs, AMQP URLs, bearer tokens, and `password=` values. Chain-of-thought is not requested or stored.

Repeated use of the same idempotency key returns the original turn. The same department repeating the same body closes the conversation as a loop. Message count, token sum, and idle time each close a conversation. Disagreement does not force a resolution.

## Memory

Dialogue does not insert memory rows. A test counts `memories` before and after a three-turn exchange and expects the same count. Reading a transcript requires `autonomy:manage`, `message:admin`, or membership in the participant set. Research, which is outside the Science–Math exchange, receives 403. Promotion of a conclusion into department memory still uses the existing Memory & Forgetting path and is not automatic.

## Governance

- Default autonomy is off.
- Pause stops the next cycle before a model call.
- Cancel marks the goal cancelled and cancels the linked objective through the existing objective cancel path.
- Human tasks have scheduling rank 0 and autonomous tasks have rank 1. With one dispatch slot, the later human task is still chosen first.
- Direct arithmetic still skips CEO planning.
- The connection pool source remains `max: 3`.
- Credentials in stored prompts are redacted.

## Migration

`0015_autonomy` adds:

- `objective_runs.origin` (`human` or `autonomous`, default `human`)
- `DEPARTMENT_DIALOGUE` on the message type check
- `colony_autonomy`, `colony_goal_cycles`, `colony_goals`, `objective_subgoals`
- `department_conversations`, `conversation_participants`, `conversation_turns`

The message-type change replaces the check constraint so the new type is allowed. Existing message rows are not rewritten. The settings row is inserted disabled. Seed recreates that row after truncate.

The migration was applied on disposable `127.0.0.1:5435/colony_m101_integration` by the integration suite. It was not applied to canonical port 5433, port 5434, or the Google Cloud VM.

## API

| Method | Path | Who |
| --- | --- | --- |
| GET, PATCH | `/api/v1/autonomy/settings` | `autonomy:manage` |
| POST | `/api/v1/autonomy/pause` and `/resume` | `autonomy:manage` |
| POST | `/api/v1/autonomy/cycles` | `autonomy:manage`; one CEO selection call when due |
| GET | `/api/v1/autonomy/goals`, `/cycles`, `/summary` | administrator or the route's stated read permission |
| POST | `/api/v1/autonomy/goals/:id/cancel` | `autonomy:manage` |
| GET, POST | `/api/v1/objectives/:objectiveId/subgoals` | read, or `message:publish` to create |
| GET, POST | `/api/v1/department-conversations` | participant, or administrator to list and read |
| GET | `/api/v1/department-conversations/:id` | transcript, participants, redacted prompts, and `lines` |
| POST | `/api/v1/department-conversations/:id/turns` | a participant |

The existing `/api/v1/conversations/:correlationId` route remains the IACP correlation history.

Inspect a real transcript:

```bash
curl -sS -H "Authorization: Bearer $COLONY_ADMIN_PRINCIPAL" \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID"
```

`lines` is built from stored turns, for example `science (question): ...`.

## Tests

| Check | Result |
| --- | --- |
| `pnpm exec tsc -p tsconfig.typecheck.json --noEmit --pretty false` | Passed |
| `pnpm exec tsc -b --pretty false` | Passed |
| Unit suite | 36 files passed, 3 skipped; 223 tests passed, 7 skipped |
| Integration suite on port 5435 | 19 files passed, 66 tests passed |

Scripted providers produced the goal text and the dialogue bodies. The integration file covers disabled generation, evidenced selection, invented evidence, duplicate text, active-goal capacity, pause, a zero inference budget, cancellation, department 403s, subgoals, human direct routing, multi-turn disagreement, duplicate turns, non-participant denial, unchanged memory count, message limit, and inactivity. Unit tests cover evidence quoting, human scheduling rank, CEO and department permission denial, the direct arithmetic route, and `max: 3`.

No GPU timing is claimed. `latencyMs` in these tests is the scripted fixture.

Local commands:

```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
pnpm exec tsc -p tsconfig.typecheck.json --noEmit --pretty false
pnpm exec tsc -b --pretty false
pnpm exec vitest run --config vitest.unit.config.ts
INTEGRATION_DATABASE_URL=postgres://m101:m101@127.0.0.1:5435/colony_m101_integration \
INTEGRATION_RABBITMQ_URL=amqp://m101:m101@127.0.0.1:5673 \
pnpm exec vitest run --config vitest.integration.config.ts
```

## Known limitations

The observation summary is counts and recent objective text. It does not yet include evaluation reports, capability-gap rows, contradiction rows, or a live GPU sample. The CEO can decline when those lines show no gap.

A conversation has two departments. Multi-party invite is not implemented.

The selection call is stored on `colony_goal_cycles`. It is not an `inference_requests` row, because the objective is created after the model answers. Later specialist work on that objective is tracked by the existing objective ledger. Dialogue token totals live on the conversation row.

`POST /api/v1/autonomy/cycles` uses the API's configured OpenAI-compatible endpoint. Tests do not call that route; they pass a scripted provider into `AutonomyService`.

Human priority applies when two ready tasks compete for a dispatch slot. It does not preempt a specialist call that has already started.

Subgoals are records of a department's approach. They are not scheduled as extra objective tasks by themselves.

## Deploy on the Google Cloud VM

Do this only after review. Load the existing colony environment. Confirm the database without printing the URL.

```bash
node -e 'const u = new URL(process.env.DATABASE_URL); console.log(u.hostname, u.port, u.pathname)'
pnpm db:migrate
docker compose -f deploy/docker-compose.gcp.yml build
docker compose -f deploy/docker-compose.gcp.yml up -d --wait
pnpm colony:status
```

`0014_efficiency` and `0015_autonomy` are both additive apart from the message-type check replacement. `docker compose up` keeps named volumes. Do not run `docker compose down -v`, `docker volume rm`, `rabbitmqctl reset`, `terraform apply`, or a seed. Do not set `COLONY_ALLOW_MODEL_DOWNLOAD=true`.

After migration, autonomy remains disabled. Enable it only with an administrator call:

```bash
curl -sS -X PATCH -H "Authorization: Bearer $COLONY_ADMIN_PRINCIPAL" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' \
  "$COLONY_API/api/v1/autonomy/settings"
```

Leave it disabled if the VM should keep the current human-only behavior. A cycle still requires `POST /api/v1/autonomy/cycles`. That call uses the department model endpoint configured for the API process.

## Next milestone

C2 should add a participant invite so a third department can enter an open conversation, feed evaluation and capability-gap rows into the observation summary, and record dialogue usage on `inference_requests` when the conversation names an objective. A separate timer can call the existing cycle endpoint at `intervalMs`. It should exit immediately when autonomy is disabled, paused, or inside the cooldown, and it should not keep the twelve models busy.
