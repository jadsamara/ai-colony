# E1–E2 Efficiency

Branch: `e1-e2-efficiency`, from `main` at `cf8f3cb`.

E1 records an objective's time breakdown from the rows the colony already writes. E2 chooses a direct, lightweight, or full execution path before any model call. A closed arithmetic objective goes to Math, and the specialist text becomes the objective output. Comparison, ambiguity, and governed wording stay on the existing CEO plan and CEO synthesis path.

No live GPU run was executed for this change. The numbers below separate the earlier observed colony run, the scripted tests run here, and the latency change that remains a projection until the VM is exercised.

## What was slow

The earlier live objective was: "Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer." It completed with answer 391. That run is a measured historical result: the CEO planned Math, Science, and Research, and the objective recorded five inference requests. The planner prompt required one math task, one science task, and one research task. `prepareCeo` then called the model to plan and, after the specialists finished, called the model again to synthesize.

The shared postgres.js pool remains `max: 3` in `packages/database/src/client.ts`. A unit test locks that source text.

## Routing

`routeObjective` in `packages/core/src/objectives/efficiency.ts` is deterministic. It has no model call and no confidence score.

| Path | When | CEO model calls |
| --- | --- | --- |
| `direct` | One closed specialist signal. Math also needs a concrete number. | None. One specialist inference. |
| `lightweight` | Exactly two specialist signals joined as work to do, with no comparison or governed action. | None. One inference per specialist. The final output joins their summaries. |
| `full` | Empty, long, ambiguous, comparative, investigative, or governed wording, or anything the deterministic plan cannot validate. | Existing plan, correction, specialist, and synthesis calls. |

Specialist signals are lexical:

- Math: calculate, compute, multiply, divide, plus, minus, sum, product, percent, average, times, or a numeric expression.
- Science: hypothesis, experiment, molecule, physics, biology, chemical, temperature, boil.
- Research: citation, literature, peer-reviewed, evidence review, primary source. The bare word "research" is not a signal, so "research station" does not create a research task.
- Reasoning: contradiction, syllogism, premise, logically, if and only if.

These words force `full` before the specialist scan: compare, tradeoff, design, investigate, approve, deploy, delete, grant, permission, budget, promote, secret, credential, drop.

"Calculate 17 multiplied by 23, explain briefly, and provide the numerical answer." matches math only. The numbers 17 and 391 are not special cases in the router. "Check this argument for a contradiction in the premise..." matches reasoning only. "Calculate 12 times 4 and check whether the statement contains a contradiction." matches math and reasoning. The solar/wind station objective matches compare and tradeoff, so it stays `full`. "Stay inside a one-request budget.", "This plan will stay invalid.", and "Cancel me before planning." stay `full`.

A direct or lightweight plan is validated with the existing `validatePlan` rules, including active and staffed departments. If validation fails, the objective falls through to CEO planning. The router does not grant `objective:execute`. An unauthorized run is materialized as `awaiting_approval` and makes no inference request. A department agent still cannot submit an objective.

When every direct or lightweight task has completed, the CEO pass stores the specialist summaries as `finalOutput` and walks `running` → `synthesizing` → `completed` without a synthesis inference. A failed specialist task fails the objective. It is not replanned. A retryable specialist error still uses the existing message retry and reopens the same inference row. A repeated `TASK_RESULT` returns `duplicate`. A second CEO pass on a completed objective returns done.

The full-path planner prompt now says to add a department only when the objective needs that capability. It still requires one JSON object and the untrusted-data boundary.

## Telemetry

Migration `0014_efficiency` adds nullable columns to `objective_runs`:

- `execution_path` (`direct`, `lightweight`, `full`, or null for a run that has not chosen)
- `execution_rationale`
- `planning_completed_at`
- `synthesis_started_at`

The SQL is additive. Existing rows stay valid with nulls. Null path means the objective has not accepted a plan yet, and completion still uses CEO synthesis.

`GET /api/v1/objectives/:objectiveId/performance` uses the same visibility rule as the objective read. The breakdown is computed at read time.

| Field | Source | Meaning |
| --- | --- | --- |
| `endToEndMs` | `completed_at - created_at` | Wall clock for the objective. |
| `planningMs` | `planning_completed_at - started_at` | Wall clock through plan acceptance. On the full path this includes waiting for the planning model. |
| `planningGpuMs` | Sum of `inference_usage.latency_ms` for `plan` and `correct` | GPU time only. Null when no planning model ran. |
| `specialistGpuMs` | Sum of `latency_ms` for `specialist` | GPU time only. |
| `synthesisMs` | `completed_at - synthesis_started_at` | Wall clock of final assembly. Near zero on direct and lightweight paths. |
| `synthesisGpuMs` | Sum of `latency_ms` for `synthesize` | GPU time only. Null when synthesis did not call a model. |
| `tasks[].queueWaitMs` | Task start minus the later of task creation and dependency completion | Time spent ready, after dependencies. |
| `tasks[].dependencyWaitMs` | Latest dependency completion minus task creation | Zero when the task has no dependencies. |
| `tasks[].executionMs` | Task `completed_at - started_at` | Specialist wall clock, including its model call. |
| `tasks[].gpuInferenceMs` | Specialist `latency_ms` for that task | The model portion of specialist execution. |
| `tasks[].messageDeliveryMs` | First `message_delivery_attempts.created_at` minus `messages.created_at` | Broker delivery. Outbox publish time is stored and is not reported as delivery. |
| `inferences[]` | Inference row plus usage | Correlates request id, task id, purpose, department, status, token source, and GPU latency. |
| `departments[]` | Tasks and inferences grouped by slug | Plan, correction, synthesis, and monitor calls are attributed to `ceo`. |

Token totals stay null when the provider does not report them. `tokenAccounting` is `observed`, `partial`, or `unavailable`. Estimated tokens are not labeled observed.

The path and rationale are also stored on the objective and written to `objective.routed` in the audit log and workflow events. `objective.submitted` and `objective.completed` remain.

## Tests

| Check | Result |
| --- | --- |
| `pnpm exec tsc -p tsconfig.typecheck.json --noEmit --pretty false` | Passed |
| `pnpm exec tsc -b --pretty false` | Passed |
| Unit suite | 35 files passed, 3 skipped, 217 tests passed, 7 skipped |
| Integration suite on `127.0.0.1:5435/colony_m101_integration` | 18 files passed, 61 tests passed |

The new coverage is:

1. Arithmetic routes to Math, completes with text containing 391, and records one `specialist` inference. Planning GPU time and synthesis GPU time are null.
2. A closed contradiction routes to Reasoning with one specialist inference.
3. Two explicit capabilities use `lightweight` and two specialist inferences. The solar/wind objective in the existing workflow test still uses CEO planning, three specialists, and synthesis.
4. "Help me figure out what the colony should do next." falls back to one CEO JSON planning call and path `full`.
5. A department principal receives 403 on submit and on the performance read. Clearing `execution_authorized` leaves the direct route at `awaiting_approval` with zero provider calls until an administrator approves it.
6. The arithmetic run records `objective.submitted`, `objective.routed`, and `objective.completed` in workflow events, plus routed and completed audit rows.
7. A retryable specialist failure is delivered again, reopens the same inference row, and completes once.
8. Applying the same `TASK_RESULT` again returns `duplicate`. A second CEO pass does not add an inference.
9. `tests/integration/objectives.test.ts` passed, including the three-specialist solar workflow, the invalid-plan stop, and the one-request budget failure.
10. `packages/database/src/client.ts` still contains `max: 3`.

The scripted provider reports `latencyMs: 5`. That value is a fixture. It is not a GPU measurement.

## Measured and projected

| Item | Value | Kind |
| --- | --- | --- |
| Earlier live arithmetic objective | Answer 391, Math + Science + Research, five inference requests | Measured before this change, reported from the colony run. Not repeated here. |
| Scripted arithmetic after this change | Path `direct`, department `math`, one specialist inference, no plan inference, no synthesis inference, final text contains 391 | Measured against a scripted provider on the disposable database. |
| Scripted specialist GPU field | `specialistGpuMs: 5` | Fixture latency, not GPU time. |
| End-to-end VM latency | — | Projected to fall because four model calls are removed. No VM timing was collected. |
| PostgreSQL pool | `max: 3` | Present in source and locked by a unit test. |

## Limitations

The router is lexical. A simple request written without a recognized verb stays on the full path. That is the safe direction: an uncertain objective gets the existing CEO plan.

Direct and lightweight outputs are the specialist text. There is no second model checking that text. A permanently failed direct task fails the objective and is not expanded into a new plan.

Full orchestration still spends a planning inference and a synthesis inference. Independent lightweight tasks still follow `maxConcurrentTasks`, which defaults to 1, so two specialists run one after the other.

Department utilization is derived from task and inference rows. It is not an `nvidia-smi` sample.

Migration `0014_efficiency` was applied on the disposable database by the integration suite. It was not applied to canonical `127.0.0.1:5433/ai_colony`, port 5434, or the Google Cloud VM.

## Deploy on the Google Cloud VM

Run this on the VM, in the colony checkout, after the branch is available there. Load the existing colony environment first. Do not print `DATABASE_URL`.

```bash
node -e 'const u = new URL(process.env.DATABASE_URL); console.log(u.hostname, u.port, u.pathname)'
```

Confirm the host, port, and database name are the colony database. Then:

```bash
pnpm db:migrate
docker compose -f deploy/docker-compose.gcp.yml build
docker compose -f deploy/docker-compose.gcp.yml up -d --wait
pnpm colony:status
```

`pnpm db:migrate` applies the additive `0014_efficiency` columns. `docker compose up` recreates containers whose image changed and keeps named volumes. Ollama containers whose config did not change stay in place.

Do not run `docker compose down -v`, `docker volume rm`, `rabbitmqctl reset`, `terraform apply`, or a database seed. Do not set `COLONY_ALLOW_MODEL_DOWNLOAD=true`. Do not delete `colony-model-gaming` or any model volume.

After the agents are healthy, submit the arithmetic objective through the existing API and read `GET /api/v1/objectives/:objectiveId/performance`. The target is `executionPath: direct`, one Math task, one `specialist` inference, null `planningGpuMs`, null `synthesisGpuMs`, and a final output containing 391. Compare `endToEndMs` with the earlier five-inference run only after that live request. That comparison is not available from this session.

## E3

These are next steps, not part of this change.

- Cost-aware scheduling: once live performance rows exist, use `specialistGpuMs`, queue wait, and department inference counts to defer low-priority full-path work while a GPU department is busy. Keep the decision in the existing scheduler.
- Parallel execution: independent direct and lightweight tasks already have empty `dependsOn`. Raising `maxConcurrentTasks` for that case would let two specialists run together. The default of 1 is why the lightweight test runs in two waves.
- Further CEO reduction: a full-path plan with one specialist and no approval requirement can reuse the specialist-result assembly. Keep the synthesis model call when the plan has several departments, a dependency, or a recorded risk.
- Revisit a model classifier only if the performance endpoint shows many full-path objectives were closed single-department requests. The classifier has to cost less than the planning call it replaces.
