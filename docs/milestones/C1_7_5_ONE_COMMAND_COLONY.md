# C1.7.5 — One-Command Colony Deployment and Testing

Operator entrypoint: `./scripts/colony`

This wraps the **local** Compose stack (`docker-compose.yml`: PostgreSQL + RabbitMQ), host API process, host Ollama check, and Drizzle migrations. It does **not** replace the dedicated GPU department stack (`pnpm colony:start` / `packages/database/src/colony-cli.ts`).

## What it does

| Command | Behavior |
| --- | --- |
| `up` | `docker compose up -d --no-build`, wait for Postgres/RabbitMQ, `pnpm db:migrate`, start API if needed, check Ollama/model |
| `down` | Stop API + Compose; **never** passes `-v` / `--volumes` |
| `deploy` | Build from **checked-out** code (no `git pull`), migrate, restart API |
| `restart` | Restart Compose services + API, re-check readiness |
| `status` | Compose, DB readiness, migration journal tip vs applied rows, API, Ollama, seed presence |
| `logs` | Compose logs; `logs api` for the host API log under `tmp/colony/api.log` |
| `test` | Authenticated C1.7.4 spacecraft conversation via API; prints transcript, claims, verifications, deliverables, conclusion |

## VM commands

```bash
# One-time on a fresh checkout
cp .env.example .env          # AUTH_MODE=development, DATABASE_URL, Ollama URL
corepack enable && corepack prepare pnpm@10.18.2 --activate
pnpm install
pnpm db:seed                  # once; idempotent; never auto-run by colony up

# Day-to-day
./scripts/colony up
./scripts/colony status
./scripts/colony test         # requires local Ollama with INFERENCE_MODEL_ALIAS (default qwen3:8b)
./scripts/colony logs api
./scripts/colony down

# After pulling/checkout of new code on the VM
git pull                      # operator-controlled; deploy does not pull
./scripts/colony deploy
```

`package.json` also exposes `"colony": "./scripts/colony"` so `pnpm colony up` works.

## Safety rules

- No `docker compose down -v`. The script rejects `-v` / `--volumes` arguments.
- No automatic multi-GB model download. Missing models are reported; `test` fails with exit `13`.
- No automatic truncate/reset/reseed. `pnpm db:seed` remains a manual one-time operator step.
- Migrations run as one controlled step before API start on `up`/`deploy`. Migration failure aborts with exit `11` and does not start the API.
- Conversation recovery / lease fencing are unchanged application behavior; this script only starts infrastructure and drives HTTP.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Usage |
| 10 | Build failure |
| 11 | Migration failure |
| 12 | Readiness timeout (DB/API) |
| 13 | Inference/Ollama unavailable |
| 14 | Test incomplete / failed |
| 15 | Config (missing `.env`, auth mode, seed) |

## Assumptions

- Node 22 + pnpm 10.18.2 on the VM
- Docker Compose v2 available
- `.env` present (copied from `.env.example`); credentials are not committed
- Ollama already serving `INFERENCE_MODEL_ALIAS` on `INFERENCE_BASE_URL` for `test`
- `jq` recommended for `test` pretty-printing (Node fallback is not implemented; install `jq`)
- Dedicated GPU volumes (`colony-model-*`) are managed by `pnpm colony:*`, not this script

## Dedicated stack

For the twelve-department Ollama/agent Compose file:

```bash
pnpm colony:start    # deploy/docker-compose.gcp.yml
pnpm colony:status
pnpm colony:stop     # stop -t 30; never deletes volumes
```
