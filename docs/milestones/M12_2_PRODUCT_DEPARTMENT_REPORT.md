# M12.2 Product department

Implementation commit: `a9f347ef411f8691e969b3aa30cf5822e745e08e`.

M12.2 retires Gaming from the active inventory and adds Product as the colony's permanent internal improvement department. The active department count stays 12. Gaming's department id, agent id, serving instance, audit events, and model volume are kept. They are not renamed to Product.

## Department migration

Product was created through the existing administrator lifecycle: `proposed`, an approved `department_create` request, `provisioning`, an approved `department_activate` request, then `active`. Both approvals were decided by the system administrator. Permanent department approval still requires `approval:decide:permanent`. A CEO agent does not have that permission. The Product agent is a `department_agent` and cannot create, activate, or approve a department.

| Record | Gaming, retained | Product, new |
| --- | --- | --- |
| Department | `00000000-0000-4000-8000-00000000001c`, status `archived` | `00000000-0000-4000-8000-00000000001d`, status `active` |
| Agent | `00000000-0000-4000-8000-000000000212`, status `archived` | `00000000-0000-4000-8000-000000000213`, status `idle` |
| Serving instance | `00000000-0000-4000-8000-00000000031c`, status `stopped` | `00000000-0000-4000-8000-00000000031d`, status `configured` |
| Serving reference | `serving://gaming` | `serving://product` |

Product's registry model is the existing Qwen3-8B base, version `qwen3-8b-base-v1`. A `configured` serving row is not readiness. The real Compose endpoint is `http://ollama-product:11434`. The mock endpoint is `http://mock-product:8080`.

Active departments: CEO, Orchestration, Monitoring, Evolution, Weight Optimization, Memory & Forgetting, Evaluation, Research, Math, Reasoning, Science, and Product. Engineering remains `proposed` and has no agent or serving instance.

Archived Gaming cannot receive a new task. Routing denies it with `department_inactive` before the legacy allowlist is considered. The objective planner also rejects a task whose department is not active. The historical Gaming row, its created and archived audit events, and its stopped serving instance remain queryable.

## Product agent

Product reviews authorized evidence from monitoring, evaluation, failures, collaboration, resource use, capability assessments, and earlier experiments. From that evidence it selects participants. The same departments are not assigned to every improvement. An empty evidence set selects Monitoring to collect a baseline. A science task failure selects Science, Monitoring, Reasoning, and Orchestration. A saturated GPU selects Monitoring. A missing-department gap selects Research and Evolution, and asks Orchestration to coordinate. Gaming, Engineering, and Product are never selected as the workers.

A proposal records the problem, evidence, expected benefit, participants and why each was selected, estimated cost, risk, measurable success criteria, priority, dependencies, and approval requirements. Backlog states are `proposed`, `under_review`, `approved`, `in_progress`, `evaluating`, `completed`, and `rejected`. Each transition is appended to `product_improvement_events`, which is append-only.

After approved work is implemented, Product requests evaluation. Only the Evaluation agent can record the comparison against the baseline, including regressions and resource cost. The recommendation is `retain`, `revise`, or `revert`. Product cannot set `successful` itself. A useful memory is proposed to Memory & Forgetting with provenance `model_generated`. It is not a fact until an administrator promotes it.

Orchestration dispatches approved work. Product recommends participants and does not dispatch them.

## Governance

Product can propose. It cannot independently authorize a new permanent department, a governance change, a model promotion, a production deployment, infrastructure spending, or a destructive database change. Approving a proposal that recommends a new department requires a system administrator, and that approval does not create or activate the department. CEO can approve an ordinary improvement and cannot approve a permanent-department recommendation. Existing CEO limitations are unchanged.

## Docker

`deploy/docker-compose.gcp.yml` and `deploy/docker-compose.mock.yml` were regenerated from the active inventory.

Active services are `agent-<slug>` and `ollama-<slug>` for the real file, and `agent-<slug>` and `mock-<slug>` for the mock file. Product is `agent-product`, `ollama-product`, and `mock-product`. Gaming has no active service. The named volume `colony-model-gaming` remains declared and is not mounted. `colony-model-product` is Product's separate volume. `pnpm colony:stop` and `pnpm colony:stop:mock` still run `docker compose stop -t 30` and do not delete volumes.

`infra/gcp/m12/services.json` now lists `serving://product` instead of `serving://gaming`. `enable_paid_resources` stays false. Terraform was not applied.

The mock stack was started, reached 24 healthy containers, and was stopped. `mock-product` and `agent-product` were healthy. No Gaming service was running. This was not a real Qwen deployment. Real provision was not run, and no model was downloaded.

## Database

`0013_product_department` creates `product_improvement_proposals` and `product_improvement_events`. It does not drop, delete, or update existing rows. The event table rejects updates and deletes. The proposal table remains mutable so its status can change.

The migration was applied on the disposable database at `127.0.0.1:5435/colony_m101_integration` by the integration suite, then on canonical `127.0.0.1:5433/ai_colony`. The canonical connection was checked first: database `ai_colony`, port `5433`, data directory `/tmp/ai-colony-pg`, PostgreSQL 17.5. Port 5434 was not contacted. No new backup was taken. Routing decisions stayed at 0.

The canonical data change is idempotent. The first run archived Gaming, stopped its serving instance, and inserted Product. The second run inserted nothing and left Engineering `proposed`. Full `seed()` was not run against canonical, so `role_permissions` were not rewritten.

## Tests

| Check | Result |
| --- | --- |
| Unit | 208 passed, 7 skipped, 0 failed |
| Integration on port 5435 | 17 files, 55 passed |
| Typecheck | passed |
| Compose config, both files | passed |
| Mock stack | 24 containers healthy, including `agent-product` and `mock-product`, then stopped with `docker compose stop` |
| Canonical `0013` | applied once; second run inserted nothing |
| Real Qwen | not started |
| Paid GCP | not provisioned |

The seven skipped unit tests are the existing database-backed ledger and routing tests, which stay skipped unless their own database URLs are set.

## Limitations

Dedicated routing remains off until every endpoint answers a live probe and the worker has `COLONY_DEDICATED_ROUTING=on`. Product's serving row is `configured`, not `ready`. Twelve real Qwen processes were not started. On this 24 GB machine, real provision still exits before downloading a model when GPU or host memory limits are absent.

Gaming's historical containers from the previous mock project are stopped orphans. They were not removed, and no volume was deleted. Product does not promote weights, deploy infrastructure, or create a department. A completed proposal records an evaluation recommendation. It does not by itself change production routing or a model.
