#!/usr/bin/env bash
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Local dev environment for gc-tour-planner.
#
# Hard requirement: dev MUST NOT collide with a UAT compose stack on the
# same machine. We use a separate compose project name (gctp-dev), a
# separate compose file (infra/docker-compose.dev.yml), separate volumes,
# AND host ports shifted by +10000 from the UAT defaults. Port 3000 is
# reserved by Grafana on the nuc-deploy stack — the api default is 3030
# and the script refuses to bind 3000 if someone tries.
#
# What this does:
#   1. Source scripts/dev.env if present (or just use defaults).
#   2. Bring up infra: postgres, valkey, osrm via the dev compose file.
#   3. Wait for postgres health, then run any pending migrations.
#   4. Launch api (default :3030) + web (default :5173) on the host with
#      hot reload + interleaved [api]/[web] logs. Ctrl-C stops both;
#      infra keeps running.
#
# Stop infra:  scripts/dev-down.sh    (or: docker compose -p gctp-dev
#                                            -f infra/docker-compose.dev.yml down)
#
# OSRM first boot takes ~10 min for a country extract; subsequent boots
# are seconds. We start it but don't block — uploads / filters / map
# markers work immediately; planner endpoints come online once OSRM
# finishes preprocessing. Tail with `docker compose -p gctp-dev
#   -f infra/docker-compose.dev.yml logs -f osrm`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$ROOT/infra"
DEV_COMPOSE="$INFRA/docker-compose.dev.yml"
DEV_PROJECT="gctp-dev"
DEV_ENV="$ROOT/scripts/dev.env"

prereq() {
  command -v docker >/dev/null 2>&1 || { echo "missing: docker"; exit 1; }
  command -v pnpm   >/dev/null 2>&1 || { echo "missing: pnpm";   exit 1; }
  [ -d "$ROOT/node_modules" ] || { echo "→ run 'pnpm install' first"; exit 1; }
  [ -f "$DEV_COMPOSE" ]       || { echo "missing: $DEV_COMPOSE"; exit 1; }
}
prereq

# Optional per-machine overrides (gitignored). Defaults below if absent.
if [ -f "$DEV_ENV" ]; then
  echo "→ Loading $DEV_ENV"
  set -a
  # shellcheck disable=SC1090
  . "$DEV_ENV"
  set +a
fi

POSTGRES_USER_DEV="${POSTGRES_USER_DEV:-gctp}"
POSTGRES_PASSWORD_DEV="${POSTGRES_PASSWORD_DEV:-gctp-dev}"
POSTGRES_DB_DEV="${POSTGRES_DB_DEV:-gctp_dev}"
POSTGRES_PORT_DEV="${POSTGRES_PORT_DEV:-15432}"
VALKEY_PORT_DEV="${VALKEY_PORT_DEV:-16379}"
OSRM_PORT_DEV="${OSRM_PORT_DEV:-15000}"
API_PORT_DEV="${API_PORT_DEV:-3030}"
WEB_PORT_DEV="${WEB_PORT_DEV:-5173}"

# Hard guard: 3000 belongs to Grafana on the nuc-deploy stack. Refuse to
# bind it even if dev.env tries — the conflict is silent until a request
# arrives, and then the failure mode is "why is Grafana 401-ing my API?"
if [ "$API_PORT_DEV" = "3000" ]; then
  echo "✘ API_PORT_DEV=3000 is reserved by Grafana on nuc-deploy. Pick another (3030 default)."
  exit 1
fi

# Host-side URLs. Dev api/web run on the host, not in the compose network,
# so they need localhost + the shifted host-published port.
HOST_DB_URL="postgresql://${POSTGRES_USER_DEV}:${POSTGRES_PASSWORD_DEV}@localhost:${POSTGRES_PORT_DEV}/${POSTGRES_DB_DEV}"
HOST_VALKEY_URL="redis://localhost:${VALKEY_PORT_DEV}"
HOST_OSRM_URL="http://localhost:${OSRM_PORT_DEV}"

# Export dev-only vars so compose interpolation picks them up.
export POSTGRES_USER_DEV POSTGRES_PASSWORD_DEV POSTGRES_DB_DEV
export POSTGRES_PORT_DEV VALKEY_PORT_DEV OSRM_PORT_DEV
export OSRM_REGION_DEV="${OSRM_REGION_DEV:-europe/netherlands}"
export OSRM_REGIONS_DEV="${OSRM_REGIONS_DEV:-}"
export OSRM_MAX_TABLE_SIZE_DEV="${OSRM_MAX_TABLE_SIZE_DEV:-5000}"

compose() {
  docker compose -p "$DEV_PROJECT" -f "$DEV_COMPOSE" "$@"
}

echo "→ Starting dev infra (project=$DEV_PROJECT)"
echo "  postgres   localhost:$POSTGRES_PORT_DEV  ($POSTGRES_DB_DEV)"
echo "  valkey     localhost:$VALKEY_PORT_DEV"
echo "  osrm       localhost:$OSRM_PORT_DEV  (started in background — see osm-prep + osrm logs)"

# Bring up postgres + valkey synchronously — api needs them at boot.
compose up -d postgres valkey

# OSRM (and its osm-prep dependency) takes ~10 min on first run to
# download + preprocess the Geofabrik extract. We start it in a detached
# fire-and-forget invocation so dev iteration on UI, schema, uploads, and
# the admin surface isn't gated on it. Planner endpoints will 500 until
# osrm logs `running`; tail with:
#   docker compose -p $DEV_PROJECT -f $DEV_COMPOSE logs -f osrm
( compose up -d osrm >/dev/null 2>&1 ) &

echo "→ Waiting for postgres"
for _ in $(seq 1 30); do
  if compose exec -T postgres \
       pg_isready -U "$POSTGRES_USER_DEV" -d "$POSTGRES_DB_DEV" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! compose exec -T postgres \
       pg_isready -U "$POSTGRES_USER_DEV" -d "$POSTGRES_DB_DEV" >/dev/null 2>&1; then
  echo "  postgres did not become ready in 30s; check 'compose logs postgres'"
  exit 1
fi

echo "→ Running migrations"
DATABASE_URL="$HOST_DB_URL" pnpm --filter @gctp/db migrate:up

echo
echo "→ Launching api + web on the host"
echo "  api          → http://localhost:$API_PORT_DEV"
echo "  web          → http://localhost:$WEB_PORT_DEV"
echo "  swagger      → http://localhost:$API_PORT_DEV/docs/api"
echo "  bull-board   → http://localhost:$API_PORT_DEV/admin/queues"
echo "  Ctrl-C to stop api/web. Infra keeps running."
echo

# `set -m` enables job control so each `&`-backgrounded pipeline gets its
# own process group. Without this, SIGTERM to pnpm (the direct child)
# doesn't propagate to tsc-watch's spawned `node dist/main.js` or vite's
# child — they orphan and keep the ports bound after Ctrl-C.
set -m

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "→ Stopping api/web"
  # `jobs -p` lists pgid leaders (pid == pgid since set -m). `kill -- -PID`
  # sends to the whole process group, catching grandchildren (vite, tsc-watch's
  # node dist/main.js).
  for pgid in $(jobs -p); do
    kill -TERM -- "-$pgid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Prefix every line with [api] or [web]. stdbuf forces line-buffering so
# the prefix appears on every line even when child processes batch writes.
run_prefixed() {
  local label="$1"; shift
  (cd "$ROOT" && exec "$@") 2>&1 | stdbuf -oL sed -u "s/^/[$label] /"
}

DATABASE_URL="$HOST_DB_URL" \
VALKEY_URL="$HOST_VALKEY_URL" \
OSRM_URL="$HOST_OSRM_URL" \
OVERPASS_URL="${OVERPASS_URL:-https://overpass-api.de/api/interpreter}" \
API_PORT="$API_PORT_DEV" \
JWT_SECRET="${JWT_SECRET:-dev-secret-change-me}" \
TOUR_PLANNER="${TOUR_PLANNER:-greedy}" \
LOG_LEVEL="${LOG_LEVEL:-info}" \
  run_prefixed api pnpm --filter @gctp/api dev &

VITE_API_URL="http://localhost:$API_PORT_DEV" \
  run_prefixed web pnpm --filter @gctp/web dev &

wait
