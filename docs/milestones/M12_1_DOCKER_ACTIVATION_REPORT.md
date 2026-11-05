# M12.1 Docker activation

M12 gave every active department its own agent runtime and serving-instance identity. M12.1 connects that design to the canonical database, the objective workers, and a Docker Compose deployment. No paid GCP resource was created, and no real Qwen process was started.

## Canonical migration

`0012_dedicated_serving` was applied to `127.0.0.1:5433/ai_colony`.

Before the apply, the connection was checked: database `ai_colony`, server port `5433`, data directory `/tmp/ai-colony-pg`, PostgreSQL 17.5. The migration file is additive (`ALTER TABLE` and `CREATE TABLE` only). Port 5434 was not contacted.

After the apply:

- Drizzle has 13 recorded migrations. `department_serving_instances` exists, with unique constraints on department, endpoint reference, and normalized endpoint, plus the provider, status, and `deployment_mode = dedicated` checks.
- Routing decisions stayed at 0. Existing rows were not rewritten.
- Twelve serving rows were inserted, all `configured`, model version `qwen3-8b-base-v1`, endpoints `serving://<slug>`. A configured row is not readiness.
- Evolution and Gaming had no agents. Those two seed agents were inserted. Engineering stayed `proposed` and received no agent and no serving row.
- Running the inventory again inserts nothing.

## Docker services

`deploy/docker-compose.gcp.yml` defines 12 agent containers and 12 Ollama containers. `deploy/docker-compose.mock.yml` defines 12 agent containers and 12 mock inference containers. Ollama ports are not published. GPU devices are omitted unless a department is given an explicit device id. `pnpm colony:stop` and `pnpm colony:stop:mock` run `docker compose stop -t 30` and do not delete volumes.

| Department | Agent service | Model service | Private endpoint |
| --- | --- | --- | --- |
| CEO | `agent-ceo` | `ollama-ceo` / `mock-ceo` | `http://ollama-ceo:11434` |
| Orchestration | `agent-orchestration` | `ollama-orchestration` | `http://ollama-orchestration:11434` |
| Monitoring | `agent-monitoring` | `ollama-monitoring` | `http://ollama-monitoring:11434` |
| Evolution | `agent-evolution` | `ollama-evolution` | `http://ollama-evolution:11434` |
| Weight Optimization | `agent-weight-optimization` | `ollama-weight-optimization` | `http://ollama-weight-optimization:11434` |
| Memory & Forgetting | `agent-memory-and-forgetting` | `ollama-memory-and-forgetting` | `http://ollama-memory-and-forgetting:11434` |
| Evaluation | `agent-evaluation` | `ollama-evaluation` | `http://ollama-evaluation:11434` |
| Research | `agent-research` | `ollama-research` | `http://ollama-research:11434` |
| Math | `agent-math` | `ollama-math` | `http://ollama-math:11434` |
| Reasoning | `agent-reasoning` | `ollama-reasoning` | `http://ollama-reasoning:11434` |
| Science | `agent-science` | `ollama-science` | `http://ollama-science:11434` |
| Gaming | `agent-gaming` | `ollama-gaming` | `http://ollama-gaming:11434` |

Mock mode uses `http://mock-<slug>:8080` and is labeled `mode=mock`. Each department has a named volume `colony-model-<slug>` for a later real deployment. The mock stack does not mount model weights.

Images: `deploy/Dockerfile.agent` (`node:22.14.0-bookworm-slim`, built from this repo) and `ollama/ollama:0.9.6`. The mock image is `deploy/Dockerfile.mock`. Set `COLONY_AGENT_IMAGE` and `COLONY_AGENT_PULL_POLICY=always` to pull a prebuilt image from Artifact Registry instead of building locally. Nothing was pushed.

## Commands

```bash
pnpm colony:provision
pnpm colony:start
pnpm colony:stop
pnpm colony:restart
pnpm colony:status
pnpm colony:logs
pnpm colony:start:mock
pnpm colony:stop:mock
pnpm colony:routing:activate
pnpm colony:routing:deactivate
```

`colony:provision` checks unique endpoints, capacity, and model digests. On this 24 GB machine, with no `COLONY_GPU_VRAM_BYTES` or `COLONY_HOST_RAM_BYTES`, real provision exits 1 and does not download Qwen. A real download also requires `COLONY_ALLOW_MODEL_DOWNLOAD=true` and a configured digest in `COLONY_MODEL_DIGESTS`. A mismatched digest is not overwritten. The weight, KV-cache, and overhead figures in `docs/milestones/M12_GPU_CAPACITY_PLAN.md` are estimates. `nvidia-smi` output, when the CLI is given it, is a measurement. This session did not take that measurement.

`COLONY_ACCEPT_TASKS` defaults to true for a local worker and is set to `false` in the Compose files, so starting the stack does not drain historical outbox work.

## Dedicated routing

The objective path still uses the M10/M11 shared route until both of these are true:

1. `deploy/state/dedicated-routing.json` has `enabled: true`. `pnpm colony:routing:activate` writes that file only after every department endpoint answers a live probe. A registry status of `configured` or `ready` is not enough.
2. The worker process has `COLONY_DEDICATED_ROUTING=on`.

`pnpm colony:routing:deactivate` turns the file off and moves `ready` rows back to `configured`. It does not rewrite routing decisions. While the switch is on, a task is pinned to its serving instance and model version. A dead instance fails closed (`serving_instance_unavailable`) and is not sent to another department or to the legacy Ollama URL. A department container that has `COLONY_DEPARTMENT_SLUG` set refuses an inference host other than `ollama-<slug>` or `mock-<slug>`.

## What was tested

| Check | Result |
| --- | --- |
| Unit | 202 passed, 7 skipped, 0 failed |
| Integration on port 5435 | 16 files, 53 passed |
| Typecheck | passed |
| Compose config, both files | passed |
| Mock stack | 24 containers healthy, then stopped with `docker compose stop` |
| Math mock stopped | Math agent unhealthy. Science and Reasoning stayed healthy on their own endpoints |
| Math mock started again | Math agent became healthy |
| Real Qwen | not run |
| GCP | not provisioned |

The production objective entry (`ObjectiveService` through the CEO graph) sent its plan call to the CEO serving instance. The shared provider received no call.

## Not done

Twelve real Qwen processes are not running. Canonical serving rows are `configured`, not `ready`. Dedicated routing is off. `enable_paid_resources` is still false. No model was downloaded, trained, or promoted.
