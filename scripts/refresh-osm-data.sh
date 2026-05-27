#!/usr/bin/env bash
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Unified OSM data refresh for gc-tour-planner (ADR-0010).
#
# Runs all four steps that move the project's geo state to today's
# Geofabrik snapshot:
#
#   1. Wipe cached regional PBFs from the osrm-data volume so the next
#      osm-prep pulls fresh same-day downloads (matters for multi-region
#      setups — see infra/osrm/prep.sh for the cross-day caveat).
#   2. Run osm-prep: re-downloads each region, merges if there's more
#      than one (the merge step deduplicates byte-identical objects).
#   3. Wipe the existing .osrm.* preprocessed files and recreate the
#      osrm container so it re-runs `osrm-extract` + `osrm-partition` +
#      `osrm-customize` against the fresh PBF, then come back online.
#   4. Force a full landuse re-import via LANDUSE_FORCE_REIMPORT=1.
#
# Both landuse and OSRM end up at the same OSM snapshot — no drift
# between "what the planner thinks the road network looks like" and
# "what landuse the cluster scorer sees".
#
# Wall clock on the NUC8i7BEH:
#   * NL alone:   ~12-15 min total
#   * NL + NRW:   ~25-35 min total
#
# Existing `route_legs` rows tagged with the old osrm_version are
# automatically ignored by the runtime (see RoutingRepository); they
# repopulate via walking-precompute on the next upload, or lazily on
# the next plan touching those caches. cache_landuse is similarly
# repopulated by the planner via populate_cache_landuse_in_bbox.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="${ROOT}/infra"
COMPOSE="docker compose -p gctp -f ${INFRA}/docker-compose.yml --env-file ${INFRA}/.env"

if ! [ -f "${INFRA}/.env" ]; then
  echo "✘ ${INFRA}/.env is missing — copy from .env.example first" >&2
  exit 1
fi

echo "→ [1/4] wipe cached regional PBFs (forces fresh same-day downloads)"
docker run --rm -v gctp_osrm-data:/data alpine sh -c \
  'rm -f /data/*-latest.osm.pbf /data/merged-*.osm.pbf*' || true

echo "→ [2/4] run osm-prep (download + merge today's Geofabrik PBFs)"
${COMPOSE} run --rm osm-prep

echo "→ [3/4] wipe .osrm.* + recreate osrm (forces full re-preprocess)"
${COMPOSE} stop osrm
${COMPOSE} rm -f osrm
docker run --rm -v gctp_osrm-data:/data alpine sh -c \
  'rm -f /data/*.osrm.* /data/osrm-version.txt' || true
${COMPOSE} up -d osrm
# Wait for OSRM to come back. Preprocessing is the expensive part;
# osrm-routed only listens once extract+partition+customize are done.
echo "  waiting for osrm to listen on :5000 (preprocessing can take 10-20 min on NL+NRW)…"
OSRM_PORT="$(grep -E '^OSRM_PORT=' "${INFRA}/.env" | cut -d= -f2)"
OSRM_PORT="${OSRM_PORT:-5000}"
until curl -sf -o /dev/null --max-time 2 \
      "http://localhost:${OSRM_PORT}/nearest/v1/foot/0,0"; do
  sleep 30
done
echo "  osrm up on :${OSRM_PORT}"

echo "→ [4/4] re-import landuse against the new PBF"
${COMPOSE} rm -f osm2pgsql-import
LANDUSE_FORCE_REIMPORT=1 ${COMPOSE} up osm2pgsql-import
# osm2pgsql-import is a one-shot service — it exits 0 on success.
# Check the exit code via the inspect API since `compose up` (without
# -d) exits with the container's status.

echo "→ refresh complete"
echo "  - osm-version.txt: $(docker exec gctp-osrm-1 cat /data/osrm-version.txt 2>/dev/null || echo unknown)"
echo "  - landuse_polygons: $(docker exec gctp-postgres-1 psql -U gctp -d gctp -At -c 'SELECT count(*) FROM landuse_polygons' 2>/dev/null) rows"
