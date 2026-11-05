# M10 — Governed Department Model Routing

Status: **implementation complete, canonical deployment pending**.

This milestone wires department model selection into the operational inference path. It was tested with a scripted inference backend and with isolated PostgreSQL 17 on `127.0.0.1:5435`. It was not applied to canonical PostgreSQL. No live model inference, training, adapter promotion, or model download was run.

## 1. Executive summary

Operational department calls now resolve one routing decision before the first model call. The decision is stored on the task and reused for later attempts. A denied decision stops the objective before `provider.generate`. Evaluation and training code do not call the router. Automatic fallback and caller model overrides are denied.

The shared compatibility model remains Qwen3-8B (`00000000-0000-4000-8000-000000000101`) for the 12 seeded departments. Math and science already have active `shared_base` assignments to that same model. A department created after this set, including the proposed `engineering` department, does not inherit that route.

## 2. Git branch and commit

- Branch: `m10-governed-model-routing`
- Base: `e51e4f4` on `m9.1-ledger-activation`
- Implementation commit: `04afc2996e52f451c287423fe1aff9e9874a79fd`

Untracked files left out of the commit: `docs/audits/` and `docs/milestones/M9_1_CANONICAL_ACTIVATION_REPORT.md`.

## 3. Existing inference paths

| Path | Class | M10 behavior |
| --- | --- | --- |
| `packages/workflows/src/runtime.ts` `executePrepared` | Department operational inference | Only production `provider.generate` call. It sends `prepared.modelAlias` from the pinned decision. A served-model mismatch fails the call. |
| `packages/core/src/objectives/objective-service.ts` `prepareCeo`, `claimSpecialist`, `prepareTextCall` | Department operational inference | Creates or reuses the routing decision before inference is inserted. |
| `packages/core/src/evaluation/evaluation-service.ts` | Evaluation inference | Does not call the router or `InferenceProvider.generate`. Existing pinned manifests stay in the evaluation service. |
| `services/training/research_m75.py`, `generate_lora.py`, `train_lora.py`, `eval_lora.py` | Training or experimental inference | Python MLX path. It is outside the TypeScript router. |
| `packages/inference/src/ollama-status.ts` | Infrastructure health | `GET /api/version`, `GET /api/tags`, `GET /api/ps` only. No token generation. |
| `packages/inference/src/ollama-embeddings.ts` | Infrastructure embedding | `POST /api/embed` for memory vectors. It is not a department chat route and was not placed behind the chat router. |
| `packages/core/src/objectives/objective-service.ts` `recordProbe` | Persisted probe writer | Still writes runtime status from `/v1/models`. M10 does not call it. |
| `tests/smoke/real-model.test.ts` | Live smoke test | Not run. |

`packages/inference/src/openai.ts` is the provider implementation. Production code reaches it only through `executePrepared`.

## 4. Routing architecture

`evaluateRouting` in `packages/core/src/routing/evaluate.ts` is a pure function. Evidence, assignment rows, and the clock are inputs. It does not call Ollama or PostgreSQL.

`ObjectiveService` gathers that snapshot and appends one `routing_decisions` row. Plan, correct, and synthesize calls are attributed to the CEO department because that is the objective owner. Specialist calls use `objective_tasks.department_id`. The workflow never forwards a caller-selected model id (`requestedModelId` is null on this path).

Policy version: `m10-legacy-shared-qwen3-8b-v1`.

Health evidence TTL: 30 seconds, the same window as `RUNTIME_STALE_AFTER_MS`.

## 5. Shared default compatibility policy and exact department allowlist

Canonical inspection on 2 November 2026, in a read-only transaction, showed two active assignments:

| Department | Role | Registry model | Version | Status |
| --- | --- | --- | --- | --- |
| math | shared_base | Qwen3-8B `...0101` | 1 | active |
| science | shared_base | Qwen3-8B `...0101` | 1 | active |

Those rows authorize Qwen3-8B directly. The other seeded departments have no assignment. The legacy policy covers only these seeded ids:

| Slug | Id |
| --- | --- |
| ceo | `00000000-0000-4000-8000-000000000011` |
| orchestration | `00000000-0000-4000-8000-000000000012` |
| monitoring | `00000000-0000-4000-8000-000000000013` |
| evolution | `00000000-0000-4000-8000-000000000014` |
| weight-optimization | `00000000-0000-4000-8000-000000000015` |
| memory-and-forgetting | `00000000-0000-4000-8000-000000000016` |
| evaluation | `00000000-0000-4000-8000-000000000017` |
| research | `00000000-0000-4000-8000-000000000018` |
| math | `00000000-0000-4000-8000-000000000019` |
| reasoning | `00000000-0000-4000-8000-00000000001a` |
| science | `00000000-0000-4000-8000-00000000001b` |
| gaming | `00000000-0000-4000-8000-00000000001c` |

Canonical also contains `engineering` (`123e24dc-c194-43e0-91a7-c4df153e5030`), created through the API with status `proposed`. It is not on the allowlist. A proposed department is denied before a model is selected. The registry status of Qwen3-8B remains `not_deployed`. The legacy policy authorizes that specific registered id because the current colony already serves it. The policy does not flip `models.status` and does not authorize Qwen3-4B or Gemma.

Prior milestone notes that said "13 departments" match the canonical row count, which is 12 seeded departments plus proposed `engineering`. The seed list itself contains 12.

## 6. Governance decisions

- A rejected assignment denies the department even when it is on the allowlist (`disabled_assignment`).
- An unknown model or a family mismatch is `invalid_assignment`.
- `experimental_adapter` is `unapproved_assignment`.
- A specialized model must have registry status `available`, otherwise `deployment_not_authorized`.
- `fallback` assignments return `fallback_disabled`.
- A requested model id that differs from the resolved model returns `model_override_denied`.
- No new override permission was added.
- `department_agent` permissions were not changed. The worker executes an already authorized objective.

## 7. Task-level pinning

`routing_decisions` has a partial unique index on `task_id` and another on `(objective_id, purpose)` for objective-level calls that have no task. The first insert wins. A unique violation reads the existing row. Later attempts copy that serving model. An assignment change after the insert does not change it. A resumed running task refreshes its lease and reuses the stored alias. A self-transition from `running` to `running` is not attempted.

## 8. Worker identity verification

`claimSpecialist` loads the persisted task. The department comes from `objective_tasks.department_id`. A metadata or payload department that differs from that id is `AUTHORIZATION_DENIED` before routing. A metadata objective id that differs from the task is also denied. The assigned agent's department must match the task department. RabbitMQ payload fields are not a source of authorization.

## 9. Model digest and execution verification

The decision stores the digest supplied in the captured health evidence when the evidence tag matches the serving tag. That is the pre-execution artifact identity. Ollama cannot atomically attest the digest of the completion, so `execution_verification` stays `unverified` unless the caller supplies an execution digest. A different execution digest is `digest_mismatch` and the call is denied. `executePrepared` also fails closed when `servedModel` differs from the alias that was submitted. A previous `/api/tags` response is not recorded as proof that the backend executed that digest.

## 10. Adapter-derived model mapping

An active `capability_adapter` assignment resolves only when a derived artifact is supplied with `provenanceVerified`, the assignment's base registry id, and the assignment's adapter id. The serving alias sent to the backend is the derived model's tag, not the base tag. A missing artifact is `missing_derived_model`. A failed provenance check is `invalid_adapter_provenance`. M10 does not create derived Ollama models. A matching name alone is not accepted as provenance.

## 11. Runtime health behavior

Evidence states are `registered`, `installed`, `loaded`, `readiness_verified`, `readiness_unknown`, `runtime_unreachable`, and `evidence_stale`. Installed and not loaded is allowed, because Ollama can load on demand. `readiness_unknown` does not deny. `runtime_unreachable` and stale evidence deny the already selected model. They do not substitute Qwen3-8B. No inference call is used to prove readiness.

## 12. Memory and resource limitations

The decision records `memory_unknown` unless the caller marks memory requirements as known. Artifact byte size may be present on the evidence and is not treated as runtime memory consumption. The local machine has 24 GB unified memory. M10 does not enforce a numeric memory budget, start or stop models, or choose a model because another one is loaded. `resource_denied` and `budget_denied` are separate explicit denials.

## 13. Fallback status

`fallback_status` is constrained to `disabled`. An explicit fallback assignment is denied. Runtime failure of an assigned model does not select Qwen3-8B. No environment variable, configuration file, or implicit CEO authority enables fallback.

## 14. Capability Ledger integration

The router may count certified and synthetic snapshots for the department. The note states that an empty ledger is not zero capability and that synthetic evidence is not real performance. Counts do not select, authorize, or revoke a model. Canonical ledger tables were empty at the M9.1 activation and were not written by M10.

## 15. Audit implementation

Routing appends `routing.decision` with department, task or objective, decision id, assignment version, serving tag, digest, reason, and policy version. Completion and failure append `routing.execution` with token counts and latency when present. Prompt text and memory text are not written. Both tables are append-only. The isolated database enforces the routing update and delete triggers. Canonical audit was not written.

## 16. New migrations and deployment status

Migration `0011_routing_decisions` (`when` `1793553000000`) creates `routing_decisions`, two partial unique indexes, and checks that authorization, fallback, and verification stay in the allowed sets. `migrate.ts` installs `routing_decisions_no_update` and `routing_decisions_no_delete`.

| State | Result |
| --- | --- |
| Implemented | Yes |
| Tested with mocks | Yes |
| Tested on isolated PostgreSQL 17 with pgvector, port 5435, database `colony_routing_m10` | Yes. A second `migrateDatabase` did not reapply the SQL. |
| Deployed to canonical PostgreSQL | No. `routing_decisions` is absent. Latest migration timestamp remains `1793552000000`. |
| Verified through live inference | No |

Canonical deployment is blocked until a separate operator approval.

## 17. Unit test results

Command: `pnpm exec vitest run --config vitest.unit.config.ts` with `ROUTING_TEST_DATABASE_URL` unset.

- 169 passed
- 7 skipped
- 0 failed
- 27 test files passed, 3 skipped

The 7 skips are `routing-db.test.ts` (5), `ledger-activation.test.ts` (1), and `capability-ledger-db.test.ts` (1). They skip because their disposable database URLs were not set. They do not fall back to port 5433.

`tests/unit/routing.test.ts` covers the routing decision cases: legacy default, allowlist, new department, disabled and invalid and unapproved assignments, specialized authorization, override denial, trusted department versus forged department, pin stability, digest match and mismatch, unverified execution identity, installed-but-unloaded, stale and unreachable runtime, derived adapter success and failure, unsupported backend, disabled fallback, budget and resource denial, unknown memory, empty and synthetic capability evidence, denied calls that do not reach the backend, the alias the scripted backend receives, execution mismatch versus a routing denial, evaluation and training source isolation, health probe paths, determinism, and the absence of update or delete in the routing repository.

## 18. Integration test results and explicit skips

Isolated command: `ROUTING_TEST_DATABASE_URL=postgresql://routing:***@127.0.0.1:5435/colony_routing_m10 pnpm exec vitest run --config vitest.unit.config.ts tests/unit/routing-db.test.ts`

- 5 passed
- 0 skipped
- 0 failed

Those tests cover legacy dispatch of `qwen3:8b`, a specialized `qwen3:4b` assignment, governance denial, task pin persistence after an assignment change, concurrent claims, worker rejection of a forged department, derived adapter dispatch of `research-adapter:v3`, and append-only audit plus the immutability trigger.

The existing `tests/integration/` suite was not run. `tests/global-setup.ts` and `tests/helpers/env.ts` load `.env`, can start compose, and rewrite the database name to `ai_colony` or `ai_colony_test`. That can contact canonical port 5433. Pointing `DATABASE_URL` at port 5435 still produces an admin URL whose database name is `ai_colony`, which the disposable guard refuses. Every file below shares that setup:

| File | Skip reason |
| --- | --- |
| `tests/integration/agents.test.ts` | Shared integration setup can contact port 5433 and uses database name `ai_colony`. |
| `tests/integration/api.test.ts` | Same setup. |
| `tests/integration/budgets.test.ts` | Same setup. |
| `tests/integration/departments.test.ts` | Same setup. |
| `tests/integration/evaluation.test.ts` | Same setup. |
| `tests/integration/experiments.test.ts` | Same setup. |
| `tests/integration/governance.test.ts` | Same setup. |
| `tests/integration/hardening.test.ts` | Same setup. |
| `tests/integration/learning.test.ts` | Same setup. |
| `tests/integration/memory.test.ts` | Same setup. |
| `tests/integration/messaging.test.ts` | Same setup. |
| `tests/integration/messaging-broker.test.ts` | Same setup, and it also requires a RabbitMQ broker. |
| `tests/integration/models-audit.test.ts` | Same setup. |
| `tests/integration/objectives.test.ts` | Same setup. |
| `tests/integration/training.test.ts` | Same setup. |
| `tests/integration/setup.ts` | Shared setup module, not a standalone suite. |

`tests/smoke/real-model.test.ts` was not run because it calls live generation.

Typecheck (`tsc -p tsconfig.typecheck.json --noEmit`) and ESLint on the M10 files passed.

## 19. Canonical database preservation

Read-only transaction on `127.0.0.1:5433`, database `ai_colony`, data directory `/tmp/ai-colony-pg`. `transaction_read_only` was `on`. Port 5434 was not contacted. `/tmp/ai-colony-pg` was not modified. No insert, update, delete, or migration was issued against canonical data. Migration count remained 11 and `to_regclass('public.routing_decisions')` was null. The isolated container `ai-colony-m10-routing` was created only for the disposable database and is removed at the end of this milestone. `ai-colony-postgres` and `ai-colony-rabbitmq` were left running.

## 20. Remaining blockers before M11

1. Migration `0011_routing_decisions` is not on canonical PostgreSQL. Operational workers will fail closed on the missing table until it is approved and applied.
2. No derived Ollama model was created. Approved adapters fail closed until M11 registers a real derived artifact and its provenance.
3. Execution digest attestation is unavailable. A tag can change between `/api/tags` and the completion.
4. Memory enforcement is recorded as unknown. It does not reserve unified memory or prevent model swapping.
5. Automatic fallback remains unimplemented by design.
6. The existing integration suite still cannot be pointed at port 5435 without a new setup that never rewrites the database name to `ai_colony`.
7. Canonical `models.status` for Qwen3-8B is still `not_deployed` even though the compatibility policy authorizes that id. Changing that status was out of scope.
