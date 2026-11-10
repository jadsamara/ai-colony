# C1.7.5 — One-Command Colony Deployment and Testing

Operator entrypoint: `./scripts/colony`

Supports two explicit profiles via `COLONY_PROFILE` or `--profile`:

| Profile | Stack |
| --- | --- |
| `local` (default) | Root `docker-compose.yml` (Postgres + RabbitMQ), **host** API, **host** Ollama |
| `gpu` | Existing deploy GPU Compose (`gcp` + `gpu` + `database` [+ `publisher`]), `colony-postgres-data`, containerized `colony-api-test`, department `ollama-*` |

`deploy` **does not** `git pull`. Never `docker compose down -v`. Never auto-downloads models. Never auto-reseeds.

## Commands

```bash
./scripts/colony [--profile local|gpu] up|down|deploy|restart|status|logs|test
# or
COLONY_PROFILE=gpu ./scripts/colony up
```

| Command | Behavior |
| --- | --- |
| `up` | Start profile services, wait for DB, migrate once, start API only after migrate, check Ollama |
| `down` | Stop profile services with `stop -t 30` / safe down; volumes preserved |
| `deploy` | Build from **checked-out** code, migrate, start |
| `restart` | Restart and re-check readiness |
| `status` | Profile, compose, DB, migrations, API, Ollama, seed |
| `logs` | Compose logs; `logs api` for API |
| `test` | Authenticated C1.7.4 spacecraft conversation; prints transcript, claims, verifications, deliverables, conclusion, diagnostics |

## Local VM / laptop

```bash
cp .env.example .env
pnpm install
pnpm db:seed                 # once if departments missing
./scripts/colony up          # COLONY_PROFILE=local
./scripts/colony status
./scripts/colony test        # needs host Ollama with INFERENCE_MODEL_ALIAS
./scripts/colony down
```

## GPU Linux VM

Prerequisites:

- NVIDIA GPU + Docker with GPU support
- Node 22 / pnpm only needed on the operator machine for host-side `pnpm build` during `deploy` (image build uses Dockerfile)
- `jq` for `test`
- Copy env once:
  - `cp deploy/colony.env.example deploy/colony.env` and set `DATABASE_URL` / `RABBITMQ_URL`
  - `cp deploy/postgres/postgres.env.example deploy/postgres/postgres.env`
  - `DATABASE_URL` for containers must use hostname `postgres` on network `colony-db`, e.g. `postgres://colony:colony@postgres:5432/ai_colony`
- Models already present in `colony-model-*` volumes (script never pulls)
- Founding departments already seeded (or seed once manually)

```bash
export COLONY_PROFILE=gpu
# or: ./scripts/colony --profile gpu …

./scripts/colony up
./scripts/colony status
./scripts/colony test
./scripts/colony logs api
./scripts/colony down
```

After updating the checkout yourself:

```bash
git pull   # operator-controlled
./scripts/colony --profile gpu deploy
```

### GPU compose files reused (unchanged service names / volumes)

Dedicated project name remains `ai-colony-dedicated` from `deploy/docker-compose.gcp.yml`:

```text
docker compose \
  -f deploy/docker-compose.gcp.yml \
  -f deploy/docker-compose.gpu.yml \
  -f deploy/docker-compose.database.yml \
  -f deploy/docker-compose.publisher.yml   # unless COLONY_GPU_PUBLISHER=false
```

Plus:

- `deploy/docker-compose.postgres.yml` → volume `colony-postgres-data`, network `colony-db`
- `deploy/docker-compose.api-test.yml` + `deploy/docker-compose.api-gpu.yml` → `colony-api-test` on `colony-db` **and** `colony-dedicated` so the API can reach `ollama-science:11434` etc.

Stop dedicated services with `stop -t 30` (same as `pnpm colony:stop`). Postgres is left running unless `COLONY_GPU_STOP_POSTGRES=true`.

### GPU database targeting

`status`, migrate, and seed checks use the **same** `DATABASE_URL` as the API (path = database name). Example live VM:

```text
DATABASE_URL=postgres://colony:…@postgres:5432/ai_colony_v2
```

→ migrations/seed/status query `ai_colony_v2.drizzle.__drizzle_migrations` and `ai_colony_v2.public.departments`, never a sibling empty `ai_colony` database. The launcher never hardcodes the database name and never reseeds/resets/recreates databases.

Migration sync compares journal entry count **and** journal `when` stamps to `drizzle.__drizzle_migrations.created_at`.

### GPU API port + stale listeners

Compose project for the API is `ai-colony-api` (`COLONY_GPU_API_PROJECT`). Ports are always `127.0.0.1:3000:3000` in both `api-test.yml` and `api-gpu.yml`.

If another container already publishes host port 3000 (for example `colony-api-test-colony-api-test-1` or an older `deploy-colony-api-test-1`), `up`/`deploy` fails with a clear conflict naming that container. Stop the stale one, then retry:

```bash
docker stop <conflicting-name>
./scripts/colony --profile gpu up
```

`status` reports `api_published`, `api_identity=verified` when the expected container publishes `127.0.0.1:3000` and readiness passes, and any `api_port_3000=CONFLICT` rows for **other** containers only. Docker short vs full IDs are normalized before comparison so the expected API never conflicts with itself.

### GPU migration order

1. Ensure Postgres ready on `colony-db` for the **DATABASE_URL database**
2. Run `node packages/database/dist/migrate-cli.js` **once** in a one-shot container on `colony-db` (same `DATABASE_URL`)
3. Only then start/recreate `colony-api-test` with published `127.0.0.1:3000`

Migration failure exits `11` and does not start the API.

### GPU Ollama checks

`up` / `status` / `test` check required department containers (no download):

- `ollama-science`
- `ollama-math`
- `ollama-reasoning`

Default shared inference base for the API overlay: `COLONY_GPU_INFERENCE_BASE_URL=http://ollama-science:11434` (same model alias across departments). Dedicated routing stays off until you run `pnpm colony:routing:activate` yourself.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Usage |
| 10 | Build failure |
| 11 | Migration failure |
| 12 | Readiness timeout |
| 13 | Inference/Ollama unavailable |
| 14 | Test incomplete / failed |
| 15 | Config |

## Safety

- No `docker compose down -v` / `--volumes`
- No automatic multi-GB model download
- No automatic truncate/reset/reseed
- No changes to GPU resource allocations in overlays beyond the existing `deploy/docker-compose.gpu.yml`
- Does not stop unrelated Docker projects; GPU `down` only targets the known compose files for this profile

## Dedicated CLI (unchanged)

```bash
pnpm colony:start
pnpm colony:status
pnpm colony:stop
```
