#!/usr/bin/env bash
# Shared helpers for ./scripts/colony (C1.7.5).
# shellcheck shell=bash

set -euo pipefail

COLONY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COLONY_STATE_DIR="${COLONY_ROOT}/tmp/colony"
COLONY_API_PID_FILE="${COLONY_STATE_DIR}/api.pid"
COLONY_API_LOG_FILE="${COLONY_STATE_DIR}/api.log"
COLONY_COMPOSE_FILE="${COLONY_ROOT}/docker-compose.yml"
COLONY_JOURNAL="${COLONY_ROOT}/packages/database/src/migrations/meta/_journal.json"

# Distinct exit codes for operators.
readonly EXIT_OK=0
readonly EXIT_USAGE=2
readonly EXIT_BUILD=10
readonly EXIT_MIGRATE=11
readonly EXIT_READY=12
readonly EXIT_INFERENCE=13
readonly EXIT_TEST=14
readonly EXIT_CONFIG=15

colony_log() {
  printf '[colony] %s\n' "$*"
}

colony_warn() {
  printf '[colony] WARN: %s\n' "$*" >&2
}

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

colony_load_env() {
  local env_file="${COLONY_ROOT}/.env"
  if [[ ! -f "${env_file}" ]]; then
    if [[ -f "${COLONY_ROOT}/.env.example" ]]; then
      colony_die "${EXIT_CONFIG}" "Missing .env. Copy .env.example to .env once, then re-run. Refusing to overwrite credentials."
    fi
    colony_die "${EXIT_CONFIG}" "Missing .env"
  fi
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
  : "${DATABASE_URL:?DATABASE_URL must be set in .env}"
  : "${AUTH_MODE:=development}"
  : "${HOST:=0.0.0.0}"
  : "${PORT:=3000}"
  : "${INFERENCE_BASE_URL:=http://127.0.0.1:11434}"
  : "${INFERENCE_MODEL_ALIAS:=qwen3:8b}"
  : "${COLONY_API_BASE:=http://127.0.0.1:${PORT}}"
  : "${COLONY_DB_WAIT_SECONDS:=60}"
  : "${COLONY_API_WAIT_SECONDS:=60}"
  : "${COLONY_TEST_POLL_SECONDS:=900}"
  : "${COLONY_ADMIN_BEARER:=00000000-0000-4000-8000-000000000001}"
  : "${COLONY_SCIENCE_BEARER:=00000000-0000-4000-8000-000000000205}"
  : "${COLONY_MATH_DEPARTMENT_ID:=00000000-0000-4000-8000-000000000019}"
  : "${COLONY_REASONING_DEPARTMENT_ID:=00000000-0000-4000-8000-00000000001a}"
}

colony_compose() {
  docker compose -f "${COLONY_COMPOSE_FILE}" "$@"
}

colony_ensure_state_dir() {
  mkdir -p "${COLONY_STATE_DIR}"
}

colony_wait_postgres() {
  local deadline=$((SECONDS + COLONY_DB_WAIT_SECONDS))
  colony_log "Waiting for PostgreSQL (bounded ${COLONY_DB_WAIT_SECONDS}s)..."
  while (( SECONDS < deadline )); do
    if colony_compose exec -T postgres pg_isready -U colony -d ai_colony >/dev/null 2>&1; then
      colony_log "PostgreSQL ready."
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "PostgreSQL not ready within ${COLONY_DB_WAIT_SECONDS}s"
}

colony_wait_rabbit() {
  local deadline=$((SECONDS + COLONY_DB_WAIT_SECONDS))
  colony_log "Waiting for RabbitMQ (bounded ${COLONY_DB_WAIT_SECONDS}s)..."
  while (( SECONDS < deadline )); do
    if colony_compose exec -T rabbitmq rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
      colony_log "RabbitMQ ready."
      return 0
    fi
    sleep 1
  done
  colony_die "${EXIT_READY}" "RabbitMQ not ready within ${COLONY_DB_WAIT_SECONDS}s"
}

colony_migrate() {
  colony_log "Applying pending migrations (single controlled step)..."
  if ! (cd "${COLONY_ROOT}" && pnpm db:migrate); then
    colony_die "${EXIT_MIGRATE}" "Migration failed. API was not started. Fix migrations before retrying."
  fi
  colony_log "Migrations applied."
}

colony_journal_tip() {
  node -e '
    const j = require(process.argv[1]);
    const tip = j.entries.at(-1);
    if (!tip) process.exit(1);
    process.stdout.write(`${tip.idx}\t${tip.tag}\t${tip.when}`);
  ' "${COLONY_JOURNAL}"
}

colony_applied_migration_count() {
  colony_compose exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'drizzle';" 2>/dev/null | tr -d '[:space:]' || echo "0"
}

colony_drizzle_rows() {
  local has_schema
  has_schema="$(colony_applied_migration_count)"
  if [[ "${has_schema}" != "1" ]]; then
    echo "0"
    return 0
  fi
  colony_compose exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM drizzle.__drizzle_migrations;" 2>/dev/null | tr -d '[:space:]' || echo "0"
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

colony_start_api() {
  colony_ensure_state_dir
  if colony_api_health; then
    colony_log "API already healthy at ${COLONY_API_BASE}"
    return 0
  fi
  if colony_api_pid_alive; then
    colony_warn "API pidfile present but health check failing; restarting API process."
    colony_stop_api || true
  fi
  if [[ ! -f "${COLONY_ROOT}/apps/api/dist/server.js" ]]; then
    colony_log "Building API (apps/api/dist missing)..."
    if ! (cd "${COLONY_ROOT}" && pnpm build); then
      colony_die "${EXIT_BUILD}" "TypeScript build failed before API start."
    fi
  fi
  colony_log "Starting API on ${HOST}:${PORT} (AUTH_MODE=${AUTH_MODE})..."
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

colony_stop_api() {
  if colony_api_pid_alive; then
    local pid
    pid="$(cat "${COLONY_API_PID_FILE}")"
    colony_log "Stopping API pid ${pid}..."
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

colony_check_ollama() {
  local base="${INFERENCE_BASE_URL%/}"
  local alias="${INFERENCE_MODEL_ALIAS}"
  local version_ok=0
  local model_ok=0
  if curl -fsS --max-time 3 "${base}/api/version" >/dev/null 2>&1; then
    version_ok=1
  fi
  if [[ "${version_ok}" -eq 1 ]]; then
    if curl -fsS --max-time 5 "${base}/api/tags" 2>/dev/null | grep -Fq "\"${alias}\"" \
      || curl -fsS --max-time 5 "${base}/api/tags" 2>/dev/null | grep -Fq "\"name\":\"${alias}"; then
      model_ok=1
    elif curl -fsS --max-time 5 "${base}/api/tags" 2>/dev/null | grep -Fq "${alias}"; then
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

colony_seed_present() {
  local count
  count="$(colony_compose exec -T postgres \
    psql -U colony -d ai_colony -Atc \
    "SELECT count(*) FROM departments WHERE id = '00000000-0000-4000-8000-00000000001b';" 2>/dev/null | tr -d '[:space:]' || echo "0")"
  [[ "${count}" == "1" ]]
}

colony_http_json() {
  local method="$1"
  local path="$2"
  local bearer="$3"
  local body="${4:-}"
  if [[ -n "${body}" ]]; then
    curl -fsS --max-time 120 \
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
