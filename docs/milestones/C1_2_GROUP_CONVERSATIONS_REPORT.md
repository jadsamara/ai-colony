# C1.2 Group conversations

A department conversation can now hold 2–12 active departments. Turns are still model-generated and stored as `DEPARTMENT_DIALOGUE` messages. Autonomous goal generation stays disabled until an administrator enables it. No live GPU inference was run, and nothing was deployed.

## Files

New:

- `packages/database/src/migrations/0016_group_conversations.sql`
- `packages/core/src/autonomy/speakers.ts`
- `tests/unit/group-dialogue.test.ts`
- `tests/integration/group-dialogue.test.ts`

Extended:

- `packages/core/src/autonomy/dialogue-service.ts`
- `packages/core/src/autonomy/policy.ts`
- `packages/core/src/autonomy/repository.ts`
- `packages/core/src/autonomy/autonomy-service.ts`
- `packages/database/src/repositories/autonomy.ts`
- `packages/database/src/schema/index.ts`
- `packages/database/src/seed.ts`
- `packages/contracts/src/schemas/message.ts`
- `apps/api/src/routes/autonomy.ts`
- `packages/database/src/migrations/meta/_journal.json`
- `tests/unit/routing-migration.test.ts`

The two-department open path is unchanged in shape: the opener and one recipient become active members, and a later reply uses the same turn API.

## Migration

`0016_group_conversations` adds:

- `colony_autonomy.max_conversation_participants` (default 12, check 2–12)
- conversation closure fields: `final_conclusion`, `remaining_disagreements`, `evidence_refs`, `context_summary`, `next_sequence`
- participant state on `conversation_participants`: `active`, `invited`, `declined`, `removed`
- `conversation_membership_events`
- `conversation_turns.addressed_department_id` and `sequence`
- `conversation_turn_claims` for idempotent recovery

Existing participant rows default to `active`. The migration was applied on disposable `127.0.0.1:5435/colony_m101_integration` by the test suite. It was not applied to canonical port 5433, port 5434, or the Google Cloud VM.

## Membership and invitations

Opening a conversation seats the sender and the named recipient. Both joins are audited as `conversation.joined`.

A later department is not seated by the opener alone:

1. An active participant calls invite. The department model writes a `proposal` turn. That turn is the invitation text.
2. The invitee is stored as `invited` and can see the topic, but not the transcript.
3. The invitee accepts or declines. Accept audits `conversation.accepted` and reveals the shared transcript. Decline audits `conversation.declined` and removes read access.
4. An active participant can remove an active member. The removal is audited. Turns created after `removed_at` are omitted from that department's read. A removed department cannot speak.
5. If fewer than two active departments remain, the conversation closes as `unresolved` with reason `below_minimum`.

Active plus invited seats cannot exceed `maxConversationParticipants`. An archived department, including Gaming, cannot be invited. A department that is not a participant cannot invite. Dialogue does not read or write another department's memory.

## Speaker selection

`selectSpeaker` does not call a model. It scores active participants:

- Directed addressee of the latest turn, or a department named in that turn: +100, reason `directed`
- Unanswered question or challenge aimed at them: +35, reason `unanswered`
- Topic or latest body matches that department's capability words: +40, reason `expertise`
- Has not spoken yet: +25
- Each prior turn by that department: −5
- Spoke the latest turn: −50

Ties break by slug. A department cannot speak again while it is the latest speaker and another active department has spoken fewer times, unless the latest turn is addressed to it. In a group of three or more, a department that is ahead of the quietest member by two or more turns is also skipped. `GET /api/v1/department-conversations/:id/speaker` returns the choice. Nothing in this slice calls every participant after each message.

## Context

The prompt includes the department role, the linked objective text when one exists, the topic, questions addressed to that department, recent disagreements, recent evidence, and the transcript. Each excerpt is clipped at 500 characters. When more than eight turns exist, the older turns become one line that starts with `summary (not a verbatim transcript):`. That line is built from stored turn text. It is not a second model call and it is not stored as a message. The transcript API still returns the full bodies.

A direct-path objective cannot open a conversation. Cancelling, completing, or failing the linked objective closes an open conversation on the next maintain or speak.

## Concurrency and recovery

Each new turn locks the conversation row, assigns the next sequence, and inserts a claim keyed by the idempotency key. The model call happens after that lock is released. Persisted order is the sequence, so two replies that finish out of order still read in the assigned order.

The same idempotency key returns the stored turn and does not call the model again. If the model text was saved on the claim and the process stopped before the message insert, the next call with that key sends the stored body and does not generate again. A second caller that arrives while the claim has no body yet receives 409 for 15 seconds. Message send still uses the existing idempotency key, so a retry does not publish a second message.

Closure checks the conversation status before writing. An administrator termination stays closed if a participant speaks afterward. A participant does not have `autonomy:manage` and cannot call terminate.

## API

Existing list, open, read, and turn routes remain. Read now also returns membership, membership events, active department ids, closure fields, and `exchanges`.

| Method | Path |
| --- | --- |
| GET | `/api/v1/department-conversations/:id/speaker` |
| POST | `/api/v1/department-conversations/:id/invitations` |
| POST | `/api/v1/department-conversations/:id/accept` |
| POST | `/api/v1/department-conversations/:id/decline` |
| POST | `/api/v1/department-conversations/:id/participants/:departmentId/remove` |
| POST | `/api/v1/department-conversations/:id/terminate` |

`PATCH /api/v1/autonomy/settings` accepts `maxConversationParticipants` from 2 to 12. The default row is still `enabled: false`.

`lines` stays `department (kind): body`. `exchanges` adds the addressee. A null addressee is `group`. The IACP envelope still has one department recipient, because that constraint already exists. A group turn sets `addressedDepartmentId` to null and `metadata.audience` to `group`. The transcript is the record of who was addressed.

## Tests

Scripted providers produced every turn body. No GPU timing is claimed.

| Check | Result |
| --- | --- |
| `pnpm exec tsc -p tsconfig.typecheck.json --noEmit --pretty false` | Passed |
| `pnpm exec tsc -b --pretty false` | Passed |
| Unit suite | 37 files passed, 3 skipped; 230 tests passed, 7 skipped |
| Integration suite on port 5435 | 20 files passed, 72 tests passed |

The group tests cover a three-department transcript, a fourth department, the participant cap, directed speaker choice, disagreement and evidence, invitation and decline, outsider and archived-department denial, removal, prompt context, duplicate keys, a new service instance replaying a turn, claim recovery without a second generate, concurrent replies, the message limit, loop closure, unresolved closure, administrator termination, a direct arithmetic objective refusing a conversation, a human objective, a disabled goal cycle, and objective cancellation. The postgres.js pool source remains `max: 3`.

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

There is no worker that wakes the selected department. A caller reads `/speaker` and then asks that department to speak. That keeps the twelve models from running after every message.

The first pair is seated at open. Departments three through twelve join through invite and accept.

Group addressing is stored on the turn. The RabbitMQ envelope still names one department because the existing message check requires a single recipient.

The capability match is a fixed word list for the current department slugs. It does not call the capability ledger.

Invitation, accept, decline, and removal are explicit. Accept and decline do not invent a spoken line. The invitation sentence is the model `proposal` turn.

Dialogue still does not promote memory, and this slice does not score whether a conversation was useful beyond the stored status, disagreements, evidence ids, and token counts.

## Deploy

Do this only after review. Confirm the database without printing the URL. `0014_efficiency`, `0015_autonomy`, and `0016_group_conversations` apply together through `pnpm db:migrate`.

```bash
node -e 'const u = new URL(process.env.DATABASE_URL); console.log(u.hostname, u.port, u.pathname)'
pnpm db:migrate
docker compose -f deploy/docker-compose.gcp.yml build
docker compose -f deploy/docker-compose.gcp.yml up -d --wait
pnpm colony:status
```

Do not run `docker compose down -v`, `docker volume rm`, `rabbitmqctl reset`, `terraform apply`, or a seed. Do not set `COLONY_ALLOW_MODEL_DOWNLOAD=true`. Leave autonomy disabled unless you explicitly patch `/api/v1/autonomy/settings`.

The open, invite, and turn routes call the API process's configured model endpoint. The tests did not call those routes with a live model. They called `DialogueService` with a scripted provider.

## Four-department conversation

Seeded department ids:

- Science `00000000-0000-4000-8000-00000000001b`, agent `…0205`
- Math `00000000-0000-4000-8000-000000000019`, agent `…0204`
- Research `00000000-0000-4000-8000-000000000018`, agent `…0206`
- Reasoning `00000000-0000-4000-8000-00000000001a`, agent `…0207`

```bash
# Science opens with Math. The model writes the first turn.
curl -sS -X POST -H "Authorization: Bearer $SCIENCE_AGENT" -H "Content-Type: application/json" \
  -d '{"recipientDepartmentId":"00000000-0000-4000-8000-000000000019","topic":"Can we improve unfamiliar physics problems?","kind":"question","instruction":"Ask Math whether the current quantity model is adequate.","idempotencyKey":"physics-open-0001"}' \
  "$COLONY_API/api/v1/department-conversations"

# Math answers.
curl -sS -X POST -H "Authorization: Bearer $MATH_AGENT" -H "Content-Type: application/json" \
  -d '{"kind":"disagreement","instruction":"Disagree if the model fails for a stated case.","idempotencyKey":"physics-math-0001","addressedDepartmentId":"00000000-0000-4000-8000-00000000001b"}' \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID/turns"

# Science invites Research. Research must accept before it can read the transcript.
curl -sS -X POST -H "Authorization: Bearer $SCIENCE_AGENT" -H "Content-Type: application/json" \
  -d '{"departmentId":"00000000-0000-4000-8000-000000000018","instruction":"We need a source check. Invite Research.","idempotencyKey":"physics-invite-research"}' \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID/invitations"
curl -sS -X POST -H "Authorization: Bearer $RESEARCH_AGENT" \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID/accept"

# Research invites Reasoning, then Reasoning accepts and speaks.
curl -sS -X POST -H "Authorization: Bearer $RESEARCH_AGENT" -H "Content-Type: application/json" \
  -d '{"departmentId":"00000000-0000-4000-8000-00000000001a","instruction":"Invite Reasoning to check the contradiction.","idempotencyKey":"physics-invite-reasoning"}' \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID/invitations"
curl -sS -X POST -H "Authorization: Bearer $REASONING_AGENT" \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID/accept"

# Read the persisted exchange.
curl -sS -H "Authorization: Bearer $COLONY_ADMIN_PRINCIPAL" \
  "$COLONY_API/api/v1/department-conversations/$CONVERSATION_ID"
```

`exchanges` is built from stored turns, for example `science->math:question` and `research->group:evidence`.

## Next

A small worker can call `GET /speaker` and then the selected department's turn route on an interval, exiting immediately when the conversation is closed or the speaker is null. That is the next step if the colony should continue a discussion without an operator posting every turn. It should still respect the message, token, and participant caps, and it should not run while autonomy is disabled for goal generation. Goal generation itself remains a separate administrator-triggered cycle.
