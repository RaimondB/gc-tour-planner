#!/bin/sh
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# osm2pgsql-import container entrypoint (ADR-0009).
#
# Imports landuse polygons from the shared OSRM PBF (file:// from the
# osrm-data volume) into landuse_polygons via osm2pgsql flex-output +
# landuse.lua. One-shot: writes landuse_import_meta row on success and
# exits 0. On subsequent boots, detects the metadata row and exits early.
#
# Required env (set by compose):
#   PG_HOST       postgres hostname
#   PG_PORT       postgres port
#   PG_USER       postgres user
#   PG_PASSWORD   postgres password
#   PG_DATABASE   postgres db name
#   OSRM_REGION   region to look up the PBF for (matches osm-prep slug)
# Optional:
#   OSRM_REGIONS  multi-region — uses merged-<slug>-latest.osm.pbf
#   LANDUSE_FORCE_REIMPORT=1   skip the "already imported" short-circuit

set -eu

if [ -n "${OSRM_REGIONS:-}" ]; then
  REGION_LIST="${OSRM_REGIONS}"
elif [ -n "${OSRM_REGION:-}" ]; then
  REGION_LIST="${OSRM_REGION}"
else
  echo "[landuse-import] ERROR: OSRM_REGIONS (or OSRM_REGION) must be set" >&2
  exit 1
fi

REGIONS=$(echo "${REGION_LIST}" | tr ',' ' ' | tr -s ' ')
REGION_COUNT=$(echo "${REGIONS}" | wc -w)

# Path resolution must match infra/osrm/prep.sh.
if [ "${REGION_COUNT}" -eq 1 ]; then
  TARGET_PBF="/osrm-data/$(echo "${REGIONS}" | tr '/' '-')-latest.osm.pbf"
else
  SLUG=$(echo "${REGIONS}" | tr ' ' '\n' | sed 's|/|-|g' | paste -sd+ -)
  TARGET_PBF="/osrm-data/merged-${SLUG}-latest.osm.pbf"
fi

if [ ! -f "${TARGET_PBF}" ]; then
  echo "[landuse-import] ERROR: ${TARGET_PBF} missing — osm-prep should have produced it." >&2
  exit 1
fi

# Use libpq environment variables — these are honoured by both psql and
# osm2pgsql without needing per-tool CLI flags (osm2pgsql 1.x uses
# `--username`, 2.x uses `--user`, env vars work for both).
export PGHOST="${PG_HOST}"
export PGPORT="${PG_PORT}"
export PGUSER="${PG_USER}"
export PGPASSWORD="${PG_PASSWORD}"
export PGDATABASE="${PG_DATABASE}"

PSQL="psql -v ON_ERROR_STOP=1 -At"

# Migration must have run first; landuse_import_meta should exist. If not,
# wait/exit — the operator probably forgot to run the API's migrate:up.
if ! ${PSQL} -c "SELECT 1 FROM landuse_import_meta LIMIT 1" >/dev/null 2>&1; then
  if ${PSQL} -c "SELECT to_regclass('landuse_import_meta')" | grep -q landuse_import_meta; then
    : # table exists, just empty — proceed
  else
    echo "[landuse-import] ERROR: landuse_import_meta table not found — run pnpm --filter @gctp/db migrate:up first." >&2
    exit 1
  fi
fi

# Short-circuit: if landuse_import_meta has a row and LANDUSE_FORCE_REIMPORT
# is not set, exit immediately. This keeps subsequent compose-ups fast.
EXISTING_IMPORT=$(${PSQL} -c "SELECT imported_at FROM landuse_import_meta WHERE id=1" 2>/dev/null || true)
if [ -n "${EXISTING_IMPORT}" ] && [ "${LANDUSE_FORCE_REIMPORT:-}" != "1" ]; then
  echo "[landuse-import] landuse_import_meta already populated (${EXISTING_IMPORT}) — skipping."
  echo "[landuse-import] Set LANDUSE_FORCE_REIMPORT=1 to re-run from scratch."
  exit 0
fi

echo "[landuse-import] importing ${TARGET_PBF} into ${PG_DATABASE}@${PG_HOST}"

# Wipe the target tables BEFORE osm2pgsql runs — --slim --drop --create
# wants to own the tables and will DROP+CREATE them from the Lua
# definition, which our migrations also create. TRUNCATE is the safest
# neutral state: osm2pgsql sees existing (empty) tables and recreates
# them cleanly. parking_facilities is populated from the same Lua pass
# (ADR-0011); both tables refresh atomically.
${PSQL} -c "TRUNCATE landuse_polygons RESTART IDENTITY CASCADE;"
${PSQL} -c "TRUNCATE parking_facilities RESTART IDENTITY CASCADE;"

# Wipe any in-flight flat.bin from a previous failed import.
rm -f /var/lib/osm2pgsql/flat.bin

# Tuneable knobs (compose env, default values pick a memory-safe profile
# on the 16 GB NUC):
#   OSM2PGSQL_CACHE     — MB held in RAM for node-id → location lookups.
#                         Bumping from 256 → 1024 cuts disk I/O significantly
#                         (~25-40% faster). Costs ~+800 MB peak RSS.
#   OSM2PGSQL_PROCESSES — parallel workers for the processing phases.
#                         NUC has 4 physical / 8 logical cores; 4 is the
#                         memory-conservative default, 8 uses hyperthreads.
#   OSM2PGSQL_EXTRA     — free-form extra flags. Example: set to
#                         "--cache 4096 -O flex" and drop --slim from above
#                         (manual edit) for the fastest non-slim import.
OSM2PGSQL_CACHE="${OSM2PGSQL_CACHE:-256}"
OSM2PGSQL_PROCESSES="${OSM2PGSQL_PROCESSES:-4}"

echo "[landuse-import] osm2pgsql tuning: cache=${OSM2PGSQL_CACHE}MB processes=${OSM2PGSQL_PROCESSES}${OSM2PGSQL_EXTRA:+ extra=${OSM2PGSQL_EXTRA}}"

# shellcheck disable=SC2086  # OSM2PGSQL_EXTRA is intentionally word-split.
osm2pgsql \
  --slim --drop \
  --flat-nodes /var/lib/osm2pgsql/flat.bin \
  --cache "${OSM2PGSQL_CACHE}" \
  --number-processes "${OSM2PGSQL_PROCESSES}" \
  --output=flex \
  --style /srv/osm-features.lua \
  ${OSM2PGSQL_EXTRA:-} \
  "${TARGET_PBF}"

# Capture the PBF's data timestamp for landuse_import_meta. osmium fileinfo
# is installed alongside osm2pgsql in the wiktorn-style images we base on.
PBF_TS=$(osmium fileinfo -e -g data.timestamp.last "${TARGET_PBF}" 2>/dev/null || echo '')

${PSQL} -c "
INSERT INTO landuse_import_meta (id, imported_at, pbf_timestamp, source_file)
VALUES (1, now(), $(if [ -n "${PBF_TS}" ]; then echo "'${PBF_TS}'"; else echo "NULL"; fi), '${TARGET_PBF}')
ON CONFLICT (id) DO UPDATE SET
  imported_at = EXCLUDED.imported_at,
  pbf_timestamp = EXCLUDED.pbf_timestamp,
  source_file = EXCLUDED.source_file,
  -- Reset replication state — a fresh import is a new baseline.
  replicated_at = NULL,
  replication_state = NULL;
"

LANDUSE_COUNT=$(${PSQL} -c "SELECT count(*) FROM landuse_polygons")
PARKING_COUNT=$(${PSQL} -c "SELECT count(*) FROM parking_facilities")
echo "[landuse-import] done — ${LANDUSE_COUNT} polygons in landuse_polygons, ${PARKING_COUNT} rows in parking_facilities"
