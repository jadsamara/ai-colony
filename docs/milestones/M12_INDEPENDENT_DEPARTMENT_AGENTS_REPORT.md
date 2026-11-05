# M12 independent department agents

Implementation commit: `b227344e168666bb0d7c0b1eb8828329e6829593`.

M12 adds a dedicated serving instance and an independent agent runtime for every active department. It does not start twelve Qwen processes, call a live model, or create GCP resources.

## 1. Architecture

Each active department now has its own agent id, runtime object, memory namespace, tool list, execution budget, and serving-instance identity. A task that enters this runtime can use only that department's bound endpoint. If the endpoint is down, the task fails. It is not sent to another department's model.

The M10/M11 shared Qwen route remains for callers that do not pass a dedicated serving context. Objective workers were not switched onto twelve live endpoints, because those processes are not running. The new runtime always requires the dedicated context.

## 2. Reused components

- Department and agent ids from the existing seed.
- `evaluateRouting` for model assignment, adapter provenance, budgets, and override denial.
- Append-only routing decisions. New columns are nullable, so older decisions stay valid.
- Memory authorization rules. The runtime adds a separate namespace check and does not replace the database policy.
- Drizzle migrations and the disposable PostgreSQL suite on port 5435.

No second agent registry or workflow engine was added.

## 3. Active department inventory

The seed has 12 active departments. Engineering is not in that seed. A proposed Engineering record passed to the planner is ignored.

| Department | Agent | Serving instance | Endpoint reference |
| --- | --- | --- | --- |
| CEO | `…0201` | `…0311` | `serving://ceo` |
| Orchestration | `…0202` | `…0312` | `serving://orchestration` |
| Monitoring | `…0203` | `…0313` | `serving://monitoring` |
| Evolution | `…0211` | `…0314` | `serving://evolution` |
| Weight Optimization | `…0208` | `…0315` | `serving://weight-optimization` |
| Memory & Forgetting | `…0210` | `…0316` | `serving://memory-and-forgetting` |
| Evaluation | `…0209` | `…0317` | `serving://evaluation` |
| Research | `…0206` | `…0318` | `serving://research` |
| Math | `…0204` | `…0319` | `serving://math` |
| Reasoning | `…0207` | `…031a` | `serving://reasoning` |
| Science | `…0205` | `…031b` | `serving://science` |
| Gaming | `…0212` | `…031c` | `serving://gaming` |

Ids share the prefix `00000000-0000-4000-8000-`. Evolution and Gaming did not have seed agents. They now do. No two departments share an instance id or an endpoint reference. Binding two references to the same URL, including `localhost` and `127.0.0.1`, is rejected.

## 4. Runtime

`DepartmentAgentRuntime` owns one department's tasks, tool log, and checkpoint. `DepartmentColony` holds one runtime per active department. A department is not a prompt swap on a shared object.

The loop accepts a task, calls only its bound model, runs an authorized tool, or sends a governed collaboration message. Limits cover steps, wall clock, tokens, tool calls, retries, and a daily count. A repeated tool idempotency key does not run again.

## 5. Dedicated serving

`department_serving_instances` stores one row per department. The deployment mode check allows only `dedicated`. Endpoint reference, normalized endpoint, and department id are unique. Status changes are recorded in `department_serving_events`, which is append-only.

The endpoint a process calls comes from a trusted directory. A task-supplied URL cannot select it.

## 6. Isolation

Math cannot read Science's namespace. Tools outside a department's list are denied. Model and endpoint overrides are denied. A pinned task whose model version no longer matches the live instance is refused instead of being moved.

## 7. Communication

Collaboration messages carry both agents, both departments, the task, a correlation id, a type, a payload, an authorization mark, a delivery status, and an idempotency key. A second delivery of the same key does nothing. Science may call Math and Reasoning. It cannot call an unlisted department. Private memory is not copied into the message.

## 8. Checkpoints

`department_agent_checkpoints` and the in-memory store keep the task, the serving instance, and the model version. Resume continues that pin. A changed version raises `SERVING_MIGRATION_REQUIRED`.

## 9. Routing

Dedicated decisions use policy `m12-dedicated-serving-v1` and record the instance, the endpoint reference, and the agent on the routing decision. Historical rows stay immutable. The shared M10 policy is unchanged when `dedicated` is omitted.

## 10. Resources

Each profile has its own step, token, tool, timeout, concurrency, and daily limits. Failure reasons stay distinct: agent stopped, serving unavailable, migration required, budget exceeded, tool denied, memory denied. Nothing reroutes a failed call.

## 11. GCP readiness

`gcpDeploymentPlan` returns 12 service records and `enablePaidResources: false`. `infra/gcp/m12/main.tf` defaults that flag to false and was not applied. The deployment guide is `docs/milestones/M12_GCP_DEPLOYMENT_GUIDE.md`.

## 12. GPU estimates

`docs/milestones/M12_GPU_CAPACITY_PLAN.md`. Twelve 5.2 GB weight sets are about 62.4 GB before KV cache and overhead. That does not fit in 24 GB. Nothing was measured on a GPU. Memory is not assumed to pool across devices.

## 13. Tests

| Check | Result |
| --- | --- |
| Unit suite, Node 22 | 197 passed, 7 skipped, 0 failed |
| Integration suite on port 5435, Node 22 | 15 files, 51 passed, 0 failed |
| `tsc -p tsconfig.typecheck.json --noEmit` | passed |
| ESLint on the M12 TypeScript files | passed |

The 7 skipped unit tests require an extra database URL and were already skipped. M12's own file passed 9 tests: unique runtimes, shared-endpoint rejection, endpoint override, Science/Math/Reasoning collaboration, restart without a second tool call, governance denials, Math failure while Science continues, and a pinned version that survives a Science upgrade.

## 14. What was verified how

| Claim | State |
| --- | --- |
| Independent runtimes and dedicated instance identities | Implemented and tested with mocks |
| Twelve real Qwen3-8B processes | Not started and not verified |
| One real local Qwen call in this milestone | Not run |
| GCP resources | Not created |
| Migration `0012_dedicated_serving` on port 5435 | Applied by the disposable integration database |
| Canonical `127.0.0.1:5433` / `ai_colony` | Not modified. Read-only check: data directory `/tmp/ai-colony-pg`, latest migration timestamp `1793553000000`, `department_serving_instances` absent |

Canonical was left at M11 because no recovery backup for port 5433 was verified. The dumps under `ai-colony-backups` are for port 5434. Port 5434 was not contacted.

## 15. Limits

- Objective workers still use the shared route until an operator binds twelve endpoints and turns dedicated routing on for that path.
- Seeded instances are `configured`, not `ready`. Configuration is not a running server.
- Weight Optimization and Evaluation agents still point at Gemma for training proposals. Their dedicated serving row plans Qwen3-8B and does not load it.
- No adapter was trained or promoted.
- Replicas of one department's server require an explicit later config. They are not implied by colocation.

## 16. Next milestone

Bind real endpoints only after capacity is measured on the chosen GPU host. Then migrate canonical `0012` from a fresh backup, start one dedicated process, and prove fail-closed behavior before starting the rest. Do not treat this report as that deployment.
