# C1.3 Autonomous Conversation Runtime

One authorized start now schedules the next department, calls that department's model, stores the turn, and continues until the conversation reaches a stopping condition. The caller does not advance each message. Goal generation stays off unless an administrator enables it separately.

No production deploy was performed. No live GPU run was performed. Migration `0017` was applied only to the disposable integration database on port `5435`.

## Files changed

- `packages/database/src/migrations/0017_conversation_runtime.sql`
- `packages/database/src/migrations/meta/_journal.json`
- `packages/database/src/schema/index.ts`
- `packages/database/src/seed.ts`
- `packages/database/src/repositories/autonomy.ts`
- `packages/core/src/autonomy/conversation-runner.ts`
- `packages/core/src/autonomy/dialogue-service.ts`
- `packages/core/src/autonomy/speakers.ts`
- `packages/core/src/autonomy/repository.ts`
- `packages/core/src/autonomy/autonomy-service.ts`
- `packages/core/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/types.ts`
- `apps/api/src/routes/autonomy.ts`
- `tests/integration/conversation-runtime.test.ts`
- `tests/unit/group-dialogue.test.ts`
- `tests/unit/routing-migration.test.ts`

## Migration

`0017_conversation_runtime` is additive.

`colony_autonomy` gains:

- `conversation_execution_enabled` default `false`
- `max_concurrent_conversation_turns` default `1` (range 1–4)
- `context_token_budget` default `1500` (range 200–8000)

`department_conversations` gains outcome, pause, runner status, fence, lease, parent conversation, scheduled speaker, last error, and last inference latency.

New tables:

- `conversation_jobs` — one pending or leased job per conversation, unique idempotency key `advance:<conversation id>:<fence>`
- `conversation_context_events` — search and summary retrieval records

Original transcript rows are not rewritten.

## Runtime architecture

`ConversationRunner.run` is the execution loop.

1. Require `autonomy:manage` and `conversationExecutionEnabled`.
2. Close the conversation first if its linked objective is already terminal.
3. Insert one durable job if none is active.
4. Claim that job under a row lock, outside the model call.
5. Ask the selected department's model for one JSON decision.
6. Validate the decision, then persist it through the existing dialogue service.
7. Schedule the next job when the conversation is still open.

The database transaction ends before `provider.generate`. A crash during inference leaves the job leased. After the lease expires, the same job is claimed again. The turn key `runner:<job id>` keeps a single transcript row and a single usage charge once the body has been stored.

`POST /api/v1/department-conversations/:id/run` performs this loop inside the API process. The API does not open a RabbitMQ connection on boot. An optional wake callback can publish `{ jobId, conversationId, fence }` after the job commits. Tests publish that payload through `ScriptedTransport` on `department.<opener>` and then deliver it twice. The second delivery finds the completed job and does not call the model.

There is no always-on model loop. Idle conversations do not poll a model.

## Queues and workers

| Work | Where it lives | Responsibility |
| --- | --- | --- |
| Conversation job | `conversation_jobs` | One active turn per conversation. Status `pending`, `leased`, `completed`, or `dead`. |
| Turn claim | `conversation_turn_claims` | Idempotent model body for `runner:<job id>`. |
| Wake publish | Optional `MessageTransport` | Best-effort notice after the Postgres commit. A lost publish does not lose the job. |
| Duplicate delivery | `ConversationRunner.handleDelivery` | Completed or dead jobs return without a model call. |
| Department inference | Existing department model route | One department per turn. The CEO is not called to choose a speaker or to write a dialogue line. |

Different conversations can hold different jobs. `max_concurrent_conversation_turns` caps how many of those jobs may be leased at once. The default is 1 because the 12 department models share one GPU. A second conversation receives backpressure and is not given a model call. A department that already holds a lease is not given a second lease.

## State machine

Runner status: `idle`, `scheduled`, `running`, `paused`, `waiting_on_child`, `stopped`.

Outcomes, stored separately from the older status and close reason:

| Outcome | When |
| --- | --- |
| `resolved` | A validated resolution turn |
| `unresolved` | Close, no speaker, no progress, or fewer than two participants |
| `budget_exhausted` | Message or token limit. Status stays `terminated` and the close reason stays `message_limit` or `token_limit` |
| `cancelled` | Linked objective completed, failed, or cancelled |
| `failed` | Model output stayed invalid |
| `administratively_stopped` | Administrator reason text contains "administrator" |

A resolution is accepted when an evidence turn already exists or the model text acknowledges uncertainty (`uncertain`, `cannot verify`, `not established`, `unresolved`). Otherwise the runtime stores it as an ordinary response and does not close. Agreement is not treated as correctness.

Pause stops new claims. An inference that already passed the claim can still store its turn, and the runner does not schedule another turn while paused. Resume schedules the next job only. Global conversation execution is a separate flag from goal generation.

## Speaker selection

The C1.2 scorer still chooses the speaker. It does not call a model.

- A latest turn aimed at a department scores highest.
- An unanswered question, challenge, or disagreement keeps that department in contention.
- Topic expertise applies to a department that has not spoken yet. Later expertise comes from the latest turn, so the topic word does not let one department speak forever.
- Departments that have not spoken get a bonus. Each prior turn lowers the score. The latest speaker is penalized.
- A department ahead of the quietest member by two or more turns is skipped, unless the latest turn is addressed to them.
- A pending invitation is handled before this scorer, so the invited department accepts or declines before the next free speaker.

The manual turn route remains. While the runner lease is valid, a manual turn whose key does not start with `runner:` returns 409.

## Context

`buildDialogueContext` packs recent turns verbatim until `context_token_budget`. Older turns become one summary line that cites `message <id>`. The original rows stay in `conversation_turns`.

`POST /api/v1/department-conversations/:id/search` with `{ query, limit }` reads the caller's visible transcript. The query is a bounded `ILIKE` match, at most 8 rows. Removed members do not see turns after their removal. Invited members do not receive transcript text. Outsiders receive 403. Each search writes `conversation_context_events` and counts the returned text toward the conversation token budget. The runner allows one search per turn, then ignores a second search request.

## Resource accounting

- Human objectives with a task in `pending`, `ready`, `dispatched`, or `running` defer conversation claims. The model is not called.
- Conversation message, token, and duration limits still close the dialogue.
- Inference counts and token totals come from stored turns. `last_inference_latency_ms` is the provider's measured latency, or null when no turn has stored one.
- Search tokens are added to the conversation input total.
- The shared Postgres pool remains `max: 3`.
- Direct arithmetic routing and CEO goal-generation defaults are unchanged.

## Failure recovery

| Failure | What is guaranteed |
| --- | --- |
| Duplicate schedule | The partial unique index and the conversation row lock leave one active job. |
| Duplicate delivery | A completed job does not generate again. |
| Worker dies before the turn body is saved | The lease expires, the same job runs again, and inference can repeat. |
| Worker dies after the body is saved | The idempotency key returns the stored turn and does not generate again. |
| Stale worker | `completeJob` requires the current lease token. An older token does not schedule the next turn. |
| Three failed claims | The job becomes `dead`, the runner status becomes `stopped`, and the conversation stays open for inspection. |
| Invalid JSON | One retry, then outcome `failed` and close reason `model_invalid`. |

## API

All conversation routes stay under `/api/v1/department-conversations`.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/:id/run` | Runs the loop with the configured model endpoint |
| `POST` | `/:id/pause` | Pauses one conversation |
| `POST` | `/:id/resume` | Clears the pause and schedules the next job |
| `GET` | `/:id/runtime` | Runner status, speaker, pending job, counts, latency, last error, context events |
| `POST` | `/:id/search` | Authorized transcript search |
| `PATCH` | `/api/v1/autonomy/settings` | Also accepts `conversationExecutionEnabled`, `maxConcurrentConversationTurns`, and `contextTokenBudget` |

Existing open, turn, invite, accept, decline, remove, terminate, and read routes remain. `POST /run` and `POST /turns` call the configured model. Tests call `ConversationRunner` with a scripted provider instead of those HTTP routes.

## Configuration

| Flag | Default | Meaning |
| --- | --- | --- |
| `colony_autonomy.enabled` | `false` | CEO goal generation |
| `colony_autonomy.conversation_execution_enabled` | `false` | This runtime |
| `max_concurrent_conversation_turns` | `1` | Leased conversation inferences at once |
| `context_token_budget` | `1500` | Verbatim transcript budget |

Enabling conversation execution does not enable goal generation.

## Test results

Node 22. Integration database `127.0.0.1:5435/colony_m101_integration`. No canonical database and no live GPU.

- Unit: 37 files passed, 3 skipped; 230 tests passed, 7 skipped.
- Integration: 21 files passed, 78 tests passed.
- `tsc -p tsconfig.typecheck.json --noEmit` passed with the implementation.
- The four-department integration test uses one `run()` call. The stored turns include Math's disagreement, Research's acceptance and evidence, Reasoning's acceptance and challenge, and Science's uncertain resolution. No manual turn is inserted between them.
- Restart recovery repeats the model call when the first attempt throws before the body is stored, then leaves one transcript row.
- A second delivery of the same wake does not add a model call.
- Two `run()` calls while a human arithmetic objective has outstanding work create one job and zero dialogue model calls.
- A second conversation does not generate while the concurrency cap is leased.
- Token-budget context cites the original message id, and the stored opening text is unchanged.
- Product cannot search another department's transcript.
- A working group of Math and Research runs as a child conversation. The parent resumes with that finding in its prompt.
- Direct arithmetic routing, disabled goal generation, two-agent dialogue, and C1.2 group dialogue remain covered by the existing suites.
- `packages/database/src/client.ts` still sets pool `max: 3`.

## Known limitations

- The API drains jobs in-process on `POST /run`. It does not start a Rabbit consumer. Wake delivery is implemented and tested, and a lost wake does not drop the Postgres job.
- If the process dies before the turn body is saved, the model call can happen again. The transcript and the usage charge do not double once the body or the turn row exists.
- Speaker expertise is still a fixed word list.
- Working groups are one level deep, at most four departments, and only start when the model returns a `workingGroup` list that passes membership checks.
- Search is bounded `ILIKE`, not a vector index.
- Latency is the provider measurement stored on the conversation. No GPU utilization figure is invented.
- `POST /run` on a live server uses the configured model endpoint. The automated tests do not call that route.

## Deployment

Do not run these as part of this change. They are the operator steps when a deploy is requested.

```bash
pnpm db:migrate
docker compose -f deploy/docker-compose.gcp.yml build
docker compose -f deploy/docker-compose.gcp.yml up -d --wait
pnpm colony:status
```

Leave `enabled` and `conversation_execution_enabled` false until an administrator patches settings. Do not use `docker compose down -v`, delete volumes, reset RabbitMQ, or run seed against the canonical database.

## Start one four-department conversation

The administrator token is the system administrator principal. Science opens with Math. Research and Reasoning enter only if the model invites them and they accept. `POST /run` uses the configured model.

```bash
curl -s -X PATCH "$API/api/v1/autonomy/settings" \
  -H "authorization: Bearer 00000000-0000-4000-8000-000000000001" \
  -H "content-type: application/json" \
  -d '{"conversationExecutionEnabled":true}'

curl -s -X POST "$API/api/v1/department-conversations" \
  -H "authorization: Bearer 00000000-0000-4000-8000-000000000205" \
  -H "content-type: application/json" \
  -d '{
    "recipientDepartmentId": "00000000-0000-4000-8000-000000000019",
    "topic": "Are the current mathematical assumptions adequate?",
    "kind": "question",
    "instruction": "Math, are the current assumptions adequate?",
    "idempotencyKey": "runtime-science-open"
  }'
```

Use the returned `conversationId`:

```bash
curl -s -X POST "$API/api/v1/department-conversations/$ID/run" \
  -H "authorization: Bearer 00000000-0000-4000-8000-000000000001"
```

## Inspect the transcript

```bash
curl -s "$API/api/v1/department-conversations/$ID" \
  -H "authorization: Bearer 00000000-0000-4000-8000-000000000001"

curl -s "$API/api/v1/department-conversations/$ID/runtime" \
  -H "authorization: Bearer 00000000-0000-4000-8000-000000000001"
```

Seeded departments: Science `…001b` agent `…0205`, Math `…0019` agent `…0204`, Research `…0018` agent `…0206`, Reasoning `…001a` agent `…0207`.
