#!/usr/bin/env bash
# Shared helpers for ./scripts/colony (C1.7.5 local + GPU profiles).
# shellcheck shell=bash

set -euo pipefail

COLONY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COLONY_STATE_DIR="${COLONY_ROOT}/tmp/colony"
COLONY_API_PID_FILE="${COLONY_STATE_DIR}/api.pid"
COLONY_API_LOG_FILE="${COLONY_STATE_DIR}/api.log"
COLONY_LOCAL_COMPOSE="${COLONY_ROOT}/docker-compose.yml"
COLONY_GPU_BASE="${COLONY_ROOT}/deploy/docker-compose.gcp.yml"
COLONY_GPU_OVERLAY="${COLONY_ROOT}/deploy/docker-compose.gpu.yml"
COLONY_GPU_DB_NET="${COLONY_ROOT}/deploy/docker-compose.database.yml"
COLONY_GPU_PUBLISHER_FILE="${COLONY_ROOT}/deploy/docker-compose.publisher.yml"
COLONY_GPU_POSTGRES="${COLONY_ROOT}/deploy/docker-compose.postgres.yml"
COLONY_GPU_API="${COLONY_ROOT}/deploy/docker-compose.api-test.yml"
COLONY_GPU_API_OVERLAY="${COLONY_ROOT}/deploy/docker-compose.api-gpu.yml"
COLONY_JOURNAL="${COLONY_ROOT}/packages/database/src/migrations/meta/_journal.json"
COLONY_GPU_REQUIRED_OLLAMA=(ollama-science ollama-math ollama-reasoning)

readonly EXIT_OK=0
readonly EXIT_USAGE=2
readonly EXIT_BUILD=10
readonly EXIT_MIGRATE=11
readonly EXIT_READY=12
readonly EXIT_INFERENCE=13
readonly EXIT_TEST=14
readonly EXIT_CONFIG=15

colony_log() { printf '[colony] %s\n' "$*"; }
colony_warn() { printf '[colony] WARN: %s\n' "$*" >&2; }
colony_die() {
  local code="${1:-1}"
  shift || true
  printf '[colony] ERROR: %s\n' "$*" >&2
  exit "${code}"
}

colony_reject_volume_wipe() {
  local arg
  for arg in "$@"; do
    if [[ "${arg}" == "-v" || "${arg}" == "--volumes" || "${arg}" == *" down -v"* ]]; then
      colony_die "${EXIT_USAGE}" "Refusing volume wipe (${arg}). Use './scripts/colony down' which never passes -v."
    fi
  done
}

colony_load_env_file() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%\"}"
    value="${value#\"}"
    if [[ -z "${!key+x}" ]]; then
      export "${key}=${value}"
    fi
  done <"${env_file}"
}

colony_resolve_profile() {
  # Prefer explicit env; allow --profile <name> already stripped by caller into COLONY_PROFILE.
  : "${COLONY_PROFILE:=local}"
  case "${COLONY_PROFILE}" in
    local|gpu) ;;
    *) colony_die "${EXIT_USAGE}" "Unknown COLONY_PROFILE=${COLONY_PROFILE}. Use local or gpu." ;;
  esac
}

colony_load_env() {
  colony_resolve_profile
  if [[ ! -f "${COLONY_ROOT}/.env" && ! -f "${COLONY_ROOT}/deploy/colony.env" ]]; then
    colony_die "${EXIT_CONFIG}" "Missing .env (local) or deploy/colony.env (gpu). Copy from the matching *.example; refusing to invent credentials."
  fi
  # GPU operator env first if present, then repo .env (does not override already-set keys).
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_load_env_file "${COLONY_ROOT}/deploy/colony.env"
  fi
  colony_load_env_file "${COLONY_ROOT}/.env"
  : "${DATABASE_URL:?DATABASE_URL must be set for profile ${COLONY_PROFILE}}"
  : "${AUTH_MODE:=development}"
  : "${HOST:=0.0.0.0}"
  : "${PORT:=3000}"
  : "${INFERENCE_BASE_URL:=http://127.0.0.1:11434}"
  : "${INFERENCE_MODEL_ALIAS:=qwen3:8b}"
  : "${COLONY_API_BASE:=http://127.0.0.1:${PORT}}"
  : "${COLONY_DB_WAIT_SECONDS:=90}"
  : "${COLONY_API_WAIT_SECONDS:=90}"
  : "${COLONY_TEST_POLL_SECONDS:=900}"
  : "${COLONY_ADMIN_BEARER:=00000000-0000-4000-8000-000000000001}"
  : "${COLONY_SCIENCE_BEARER:=00000000-0000-4000-8000-000000000205}"
  : "${COLONY_MATH_DEPARTMENT_ID:=00000000-0000-4000-8000-000000000019}"
  : "${COLONY_REASONING_DEPARTMENT_ID:=00000000-0000-4000-8000-00000000001a}"
  : "${COLONY_GPU_MANAGE_POSTGRES:=true}"
  : "${COLONY_GPU_STOP_POSTGRES:=false}"
  : "${COLONY_GPU_PUBLISHER:=true}"
  : "${COLONY_GPU_INFERENCE_BASE_URL:=http://ollama-science:11434}"
  : "${COLONY_AGENT_IMAGE:=ai-colony-agent:m12.1}"
  export COLONY_PROFILE AUTH_MODE HOST PORT INFERENCE_BASE_URL INFERENCE_MODEL_ALIAS COLONY_API_BASE
  export COLONY_GPU_INFERENCE_BASE_URL COLONY_ACCEPT_TASKS COLONY_DEDICATED_ROUTING COLONY_MODE
}

colony_ensure_state_dir() {
  mkdir -p "${COLONY_STATE_DIR}" "${COLONY_ROOT}/deploy/state"
}

colony_compose_local() {
  docker compose -f "${COLONY_LOCAL_COMPOSE}" "$@"
}

colony_gpu_dedicated_files() {
  local files=(-f "${COLONY_GPU_BASE}" -f "${COLONY_GPU_OVERLAY}" -f "${COLONY_GPU_DB_NET}")
  if [[ "${COLONY_GPU_PUBLISHER:-true}" == "true" && -f "${COLONY_GPU_PUBLISHER_FILE}" ]]; then
    files+=(-f "${COLONY_GPU_PUBLISHER_FILE}")
  fi
  printf '%s\n' "${files[@]}"
}

colony_compose_gpu_dedicated() {
  local files=()
  # shellcheck disable=SC2207
  files=($(colony_gpu_dedicated_files))
  docker compose "${files[@]}" "$@"
}

colony_compose_gpu_postgres() {
  docker compose -f "${COLONY_GPU_POSTGRES}" "$@"
}

colony_compose_gpu_api() {
  docker compose -f "${COLONY_GPU_API}" -f "${COLONY_GPU_API_OVERLAY}" "$@"
}

colony_compose() {
  # Back-compat helper used by local paths and generic callers.
  if [[ "${COLONY_PROFILE:-local}" == "gpu" ]]; then
    colony_compose_gpu_dedicated "$@"
  else
    colony_compose_local "$@"
  fi
}

colony_wait_postgres_local() {
  local deadline=$((SECONDS + COLONY_DB_WAIT_SECONDS))
  colony_log "Waiting for local PostgreSQL (bounded ${COLONY_DB_WAIT_SECONDS}s)..."
  while (( SECONDS < deadline )); do
    if colony_compose_local exec -T postgres pg_isready -U colony -d ai_colony >/dev/null 2>&1; then
      colony_log "PostgreSQL ready."
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "PostgreSQL not ready within ${COLONY_DB_WAIT_SECONDS}s"
}

colony_wait_rabbit_local() {
  local deadline=$((SECONDS + COLONY_DB_WAIT_SECONDS))
  colony_log "Waiting for RabbitMQ (bounded ${COLONY_DB_WAIT_SECONDS}s)..."
  while (( SECONDS < deadline )); do
    if colony_compose_local exec -T rabbitmq rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
      colony_log "RabbitMQ ready."
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "RabbitMQ not ready within ${COLONY_DB_WAIT_SECONDS}s"
}

colony_wait_postgres_gpu() {
  local deadline=$((SECONDS + COLONY_DB_WAIT_SECONDS))
  colony_log "Waiting for GPU PostgreSQL on colony-db (bounded ${COLONY_DB_WAIT_SECONDS}s)..."
  while (( SECONDS < deadline )); do
    if colony_compose_gpu_postgres exec -T postgres pg_isready -U colony -d ai_colony >/dev/null 2>&1; then
      colony_log "GPU PostgreSQL ready."
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "GPU PostgreSQL not ready within ${COLONY_DB_WAIT_SECONDS}s"
}

colony_migrate_local() {
  colony_log "Applying pending migrations against DATABASE_URL (local host)..."
  if ! (cd "${COLONY_ROOT}" && pnpm db:migrate); then
    colony_die "${EXIT_MIGRATE}" "Migration failed. API was not started."
  fi
  colony_log "Migrations applied."
}

colony_migrate_gpu() {
  # Run migrator once on colony-db so hostname `postgres` resolves. Never starts API first.
  colony_log "Applying pending migrations against GPU DATABASE_URL via colony-db network..."
  if [[ -z "${DATABASE_URL:-}" ]]; then
    colony_die "${EXIT_CONFIG}" "DATABASE_URL required for GPU migrations (use host postgres://…@postgres:5432/… for containers)."
  fi
  if ! docker image inspect "${COLONY_AGENT_IMAGE}" >/dev/null 2>&1; then
    colony_log "Building agent image ${COLONY_AGENT_IMAGE} for migrate/API..."
    if ! docker build -f "${COLONY_ROOT}/deploy/Dockerfile.agent" -t "${COLONY_AGENT_IMAGE}" "${COLONY_ROOT}"; then
      colony_die "${EXIT_BUILD}" "Agent image build failed before migration."
    fi
  fi
  if ! docker run --rm \
    --network colony-db \
    -e DATABASE_URL="${DATABASE_URL}" \
    -e NODE_ENV=development \
    "${COLONY_AGENT_IMAGE}" \
    node packages/database/dist/migrate-cli.js; then
    colony_die "${EXIT_MIGRATE}" "GPU migration failed. Dedicated API start aborted."
  fi
  colony_log "GPU migrations applied."
}

colony_migrate() {
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_migrate_gpu
  else
    colony_migrate_local
  fi
}

colony_journal_tip() {
  node -e '
    const j = require(process.argv[1]);
    const tip = j.entries.at(-1);
    if (!tip) process.exit(1);
    process.stdout.write(`${tip.idx}\t${tip.tag}\t${tip.when}`);
  ' "${COLONY_JOURNAL}"
}

colony_drizzle_rows_local() {
  local has_schema
  has_schema="$(colony_compose_local exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'drizzle';" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  if [[ "${has_schema}" != "1" ]]; then
    echo "0"
    return 0
  fi
  colony_compose_local exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;" 2>/dev/null | tr -d '[:space:]' || echo "0"
}

colony_drizzle_rows_gpu() {
  local has_schema
  has_schema="$(colony_compose_gpu_postgres exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'drizzle';" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  if [[ "${has_schema}" != "1" ]]; then
    echo "0"
    return 0
  fi
  colony_compose_gpu_postgres exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;" 2>/dev/null | tr -d '[:space:]' || echo "0"
}

colony_drizzle_rows() {
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_drizzle_rows_gpu
  else
    colony_drizzle_rows_local
  fi
}

colony_api_health() {
  curl -fsS --max-time 3 "${COLONY_API_BASE}/api/v1/health" >/dev/null 2>&1
}

colony_api_ready() {
  curl -fsS --max-time 3 "${COLONY_API_BASE}/api/v1/ready" >/dev/null 2>&1
}

colony_api_pid_alive() {
  [[ -f "${COLONY_API_PID_FILE}" ]] || return 1
  local pid
  pid="$(cat "${COLONY_API_PID_FILE}")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

colony_start_api_local() {
  colony_ensure_state_dir
  if colony_api_health; then
    colony_log "API already healthy at ${COLONY_API_BASE}"
    return 0
  fi
  if colony_api_pid_alive; then
    colony_warn "API pidfile present but health check failing; restarting API process."
    colony_stop_api_local || true
  fi
  if [[ ! -f "${COLONY_ROOT}/apps/api/dist/server.js" ]]; then
    colony_log "Building API (apps/api/dist missing)..."
    if ! (cd "${COLONY_ROOT}" && pnpm build); then
      colony_die "${EXIT_BUILD}" "TypeScript build failed before API start."
    fi
  fi
  colony_log "Starting host API on ${HOST}:${PORT} (AUTH_MODE=${AUTH_MODE})..."
  (
    cd "${COLONY_ROOT}"
    nohup node apps/api/dist/server.js >>"${COLONY_API_LOG_FILE}" 2>&1 &
    echo $! >"${COLONY_API_PID_FILE}"
  )
  local deadline=$((SECONDS + COLONY_API_WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    if colony_api_ready; then
      colony_log "API ready."
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "API not ready within ${COLONY_API_WAIT_SECONDS}s. See ${COLONY_API_LOG_FILE}"
}

colony_stop_api_local() {
  if colony_api_pid_alive; then
    local pid
    pid="$(cat "${COLONY_API_PID_FILE}")"
    colony_log "Stopping host API pid ${pid}..."
    kill "${pid}" 2>/dev/null || true
    local deadline=$((SECONDS + 15))
    while (( SECONDS < deadline )) && kill -0 "${pid}" 2>/dev/null; do
      sleep 1
    done
    if kill -0 "${pid}" 2>/dev/null; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
  fi
  rm -f "${COLONY_API_PID_FILE}"
}

colony_start_api_gpu() {
  colony_ensure_state_dir
  if [[ ! -f "${COLONY_ROOT}/deploy/postgres/postgres.env" && "${COLONY_GPU_MANAGE_POSTGRES}" == "true" ]]; then
    colony_warn "deploy/postgres/postgres.env missing; copy from postgres.env.example if starting postgres via this script."
  fi
  colony_log "Starting containerized API colony-api-test (after migrations)..."
  if ! colony_compose_gpu_api up -d --no-build colony-api-test; then
    # Image may need a build once.
    if ! docker build -f "${COLONY_ROOT}/deploy/Dockerfile.agent" -t "${COLONY_AGENT_IMAGE}" "${COLONY_ROOT}"; then
      colony_die "${EXIT_BUILD}" "Agent/API image build failed."
    fi
    if ! colony_compose_gpu_api up -d --no-build colony-api-test; then
      colony_die "${EXIT_READY}" "colony-api-test failed to start."
    fi
  fi
  local deadline=$((SECONDS + COLONY_API_WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    if colony_api_ready; then
      colony_log "GPU API ready at ${COLONY_API_BASE}"
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "GPU API not ready within ${COLONY_API_WAIT_SECONDS}s"
}

colony_stop_api_gpu() {
  colony_log "Stopping colony-api-test (preserving volumes)..."
  colony_compose_gpu_api stop -t 30 colony-api-test 2>/dev/null || true
}

colony_start_api() {
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_start_api_gpu
  else
    colony_start_api_local
  fi
}

colony_stop_api() {
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_stop_api_gpu
  else
    colony_stop_api_local
  fi
}

colony_check_ollama_url() {
  local base="${1%/}"
  local alias="$2"
  local version_ok=0
  local model_ok=0
  if curl -fsS --max-time 3 "${base}/api/version" >/dev/null 2>&1; then
    version_ok=1
  fi
  if [[ "${version_ok}" -eq 1 ]]; then
    local tags
    tags="$(curl -fsS --max-time 5 "${base}/api/tags" 2>/dev/null || true)"
    if printf '%s' "${tags}" | grep -Fq "${alias}"; then
      model_ok=1
    fi
  fi
  if [[ "${version_ok}" -eq 1 && "${model_ok}" -eq 1 ]]; then
    printf 'ollama=ready model=%s endpoint=%s\n' "${alias}" "${base}"
    return 0
  fi
  if [[ "${version_ok}" -eq 0 ]]; then
    printf 'ollama=unreachable endpoint=%s (no automatic model download)\n' "${base}"
  else
    printf 'ollama=up model_missing=%s endpoint=%s (no automatic model download)\n' "${alias}" "${base}"
  fi
  return 1
}

colony_check_ollama_local() {
  colony_check_ollama_url "${INFERENCE_BASE_URL}" "${INFERENCE_MODEL_ALIAS}"
}

colony_check_one_gpu_ollama() {
  local service="$1"
  local alias="${INFERENCE_MODEL_ALIAS}"
  if ! colony_compose_gpu_dedicated ps --status running --services 2>/dev/null | grep -qx "${service}"; then
    printf '%s=not_running\n' "${service}"
    return 1
  fi
  # Prefer container-local ollama CLI; never pull.
  if colony_compose_gpu_dedicated exec -T "${service}" ollama list 2>/dev/null | grep -Fq "${alias}"; then
    printf '%s=ready model=%s\n' "${service}" "${alias}"
    return 0
  fi
  if colony_compose_gpu_dedicated exec -T "${service}" ollama list >/dev/null 2>&1; then
    printf '%s=up model_missing=%s (no automatic model download)\n' "${service}" "${alias}"
  else
    printf '%s=unreachable\n' "${service}"
  fi
  return 1
}

colony_check_gpu_ollama() {
  local ok=0
  local service
  for service in "${COLONY_GPU_REQUIRED_OLLAMA[@]}"; do
    if colony_check_one_gpu_ollama "${service}"; then
      ok=$((ok + 1))
    fi
  done
  if [[ "${ok}" -eq "${#COLONY_GPU_REQUIRED_OLLAMA[@]}" ]]; then
    return 0
  fi
  return 1
}

colony_check_ollama() {
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_check_gpu_ollama
  else
    colony_check_ollama_local
  fi
}

colony_seed_present_local() {
  local count
  count="$(colony_compose_local exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM departments WHERE id = '00000000-0000-4000-8000-00000000001b';" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  [[ "${count}" == "1" ]]
}

colony_seed_present_gpu() {
  local count
  count="$(colony_compose_gpu_postgres exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM departments WHERE id = '00000000-0000-4000-8000-00000000001b';" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  [[ "${count}" == "1" ]]
}

colony_seed_present() {
  if [[ "${COLONY_PROFILE}" == "gpu" ]]; then
    colony_seed_present_gpu
  else
    colony_seed_present_local
  fi
}

colony_http_json() {
  local method="$1"
  local path="$2"
  local bearer="$3"
  local body="${4:-}"
  if [[ -n "${body}" ]]; then
    curl -fsS --max-time 180 \
      -X "${method}" \
      -H "Authorization: Bearer ${bearer}" \
      -H "Content-Type: application/json" \
      -H "X-Correlation-Id: colony-ops" \
      -d "${body}" \
      "${COLONY_API_BASE}${path}"
  else
    curl -fsS --max-time 60 \
      -X "${method}" \
      -H "Authorization: Bearer ${bearer}" \
      -H "X-Correlation-Id: colony-ops" \
      "${COLONY_API_BASE}${path}"
  fi
}

colony_gpu_ensure_postgres() {
  if [[ "${COLONY_GPU_MANAGE_POSTGRES}" != "true" ]]; then
    colony_log "COLONY_GPU_MANAGE_POSTGRES=false; assuming postgres on colony-db is already running."
    return 0
  fi
  if [[ ! -f "${COLONY_ROOT}/deploy/postgres/postgres.env" ]]; then
    colony_die "${EXIT_CONFIG}" "Missing deploy/postgres/postgres.env. Copy from deploy/postgres/postgres.env.example."
  fi
  colony_log "Ensuring GPU postgres stack (volume colony-postgres-data)..."
  colony_compose_gpu_postgres up -d --no-build
}

colony_print_gpu_compose_invocation() {
  # Used by unit tests / docs — exact dedicated stack files.
  echo "docker compose -f deploy/docker-compose.gcp.yml -f deploy/docker-compose.gpu.yml -f deploy/docker-compose.database.yml [-f deploy/docker-compose.publisher.yml]"
}
