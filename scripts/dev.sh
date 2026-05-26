#!/usr/bin/env bash
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Local dev environment for gc-tour-planner.
#
# What this does:
#   1. Ensure infra/.env exists (copy from infra/.env.example if missing).
#   2. Bring up infra services in docker compose: postgres, valkey, osrm.
#      api/web/jobs/solver are NOT started in compose — we run api + web
#      locally for hot-reload.
#   3. Wait for postgres to be ready, then run any pending migrations.
#   4. Launch api (port 3030 by default) + web (port 5173) in parallel
#      with interleaved [api]/[web] logs. Ctrl-C stops both.
#
# Infra stays running on exit so re-running this script is fast. Stop
# infra with:  scripts/dev-down.sh    (or: cd infra && docker compose down)
#
# OSRM first boot takes ~10 min for a country extract; subsequent boots
# are seconds. We start it but don't block on it — the planner won't work
# until OSRM is ready, but everything else (uploads, filter, map markers)
# does. Check OSRM readiness:  docker compose -f infra/docker-compose.yml logs osrm

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$ROOT/infra"
COMPOSE_FILE="$INFRA/docker-compose.yml"

prereq() {
  command -v docker >/dev/null 2>&1 || { echo "missing: docker"; exit 1; }
  command -v pnpm   >/dev/null 2>&1 || { echo "missing: pnpm";   exit 1; }
  [ -d "$ROOT/node_modules" ] || { echo "→ run 'pnpm install' first"; exit 1; }
}
prereq

if [ ! -f "$INFRA/.env" ]; then
  echo "→ infra/.env missing; copying from infra/.env.example"
  cp "$INFRA/.env.example" "$INFRA/.env"
  echo "  (edit infra/.env if you need non-default ports or a different OSRM region)"
fi

# Source so we can build host-side URLs from the same credentials the
# containers use. `set -a` auto-exports every variable assigned below.
set -a
# shellcheck disable=SC1091
. "$INFRA/.env"
set +a

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
VALKEY_PORT="${VALKEY_PORT:-6379}"
OSRM_PORT="${OSRM_PORT:-5000}"
API_PORT="${API_PORT:-3030}"
WEB_PORT="${WEB_PORT:-5173}"

# Host-side URLs override the compose-internal DNS in infra/.env. The api
# and web run on the host, not in the compose network, so they need
# localhost + the host-published port.
HOST_DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
HOST_VALKEY_URL="redis://localhost:${VALKEY_PORT}"
HOST_OSRM_URL="http://localhost:${OSRM_PORT}"

echo "→ Starting infra: postgres, valkey, osrm"
(cd "$INFRA" && docker compose up -d postgres valkey osrm)

echo "→ Waiting for postgres ($POSTGRES_USER@localhost:$POSTGRES_PORT/$POSTGRES_DB)"
# Up to ~30 s of waiting. Postgres usually responds in 2-5 s after
# `compose up`; OSRM is the slow one and we deliberately don't wait for it.
for _ in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres \
       pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker compose -f "$COMPOSE_FILE" exec -T postgres \
       pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
  echo "  postgres did not become ready in 30s; check 'docker compose logs postgres'"
  exit 1
fi

echo "→ Running migrations"
DATABASE_URL="$HOST_DB_URL" pnpm --filter @gctp/db migrate:up

echo
echo "→ Launching api + web"
echo "  api          → http://localhost:$API_PORT"
echo "  web          → http://localhost:$WEB_PORT"
echo "  swagger      → http://localhost:$API_PORT/docs/api"
echo "  bull-board   → http://localhost:$API_PORT/admin/queues"
echo "  Ctrl-C to stop api/web. Infra keeps running."
echo

# Cleanup: kill any backgrounded children on Ctrl-C / exit. pnpm forks
# node, which forks tsc-watch / vite — sending SIGTERM to the pnpm pid
# usually propagates. If a stray node lingers, `pkill -f tsc-watch` or
# `pkill -f vite` clears it.
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "→ Stopping api/web"
  # `jobs -p` lists our backgrounded pids. xargs -r skips when empty.
  jobs -p | xargs -r kill -TERM 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Helper: pipe a labelled stream through sed for the prefix. `stdbuf -oL`
# forces line buffering so the prefix appears on every line, not in bursts.
run_prefixed() {
  local label="$1"; shift
  # subshell so the cd doesn't leak; `exec` so SIGTERM propagates one less hop.
  (cd "$ROOT" && exec "$@") 2>&1 | stdbuf -oL sed -u "s/^/[$label] /"
}

# api: localhost URLs for the host-running processes; everything else from .env.
DATABASE_URL="$HOST_DB_URL" \
VALKEY_URL="$HOST_VALKEY_URL" \
OSRM_URL="$HOST_OSRM_URL" \
OVERPASS_URL="${OVERPASS_URL:-https://overpass-api.de/api/interpreter}" \
API_PORT="$API_PORT" \
JWT_SECRET="${JWT_SECRET:-dev-secret-change-me}" \
TOUR_PLANNER="${TOUR_PLANNER:-greedy}" \
SOLVER_URL="${SOLVER_URL:-http://localhost:${SOLVER_PORT:-8088}}" \
LOG_LEVEL="${LOG_LEVEL:-info}" \
  run_prefixed api pnpm --filter @gctp/api dev &

# web: point at the host-exposed api port. Vite's dev server proxies /api
# to whatever VITE_API_URL says.
VITE_API_URL="http://localhost:$API_PORT" \
  run_prefixed web pnpm --filter @gctp/web dev &

wait
