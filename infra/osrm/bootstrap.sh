#!/bin/sh
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# OSRM container entrypoint. Downloads + preprocesses the configured region's
# OSM extract on first boot, then runs osrm-routed against the contracted graph.
#
# Image: ghcr.io/project-osrm/osrm-backend:latest (Alpine, has wget).
# Required env: OSRM_REGION (e.g. "europe/netherlands").
# Volume:       /data is persisted as the `osrm-data` named volume.

set -eu

REGION="${OSRM_REGION:?OSRM_REGION must be set, e.g. europe/netherlands}"
DATA_DIR="/data"
PROFILE="/opt/foot.lua"
PBF="${DATA_DIR}/$(echo "${REGION}" | tr '/' '-')-latest.osm.pbf"
OSRM_BASE="${PBF%.osm.pbf}.osrm"

mkdir -p "${DATA_DIR}"

if [ ! -f "${PBF}" ]; then
  echo "[osrm] downloading extract: ${REGION}"
  mkdir -p "$(dirname "${PBF}")"
  # Prefer wget (in the alpine image); curl is the legacy fallback.
  if command -v wget >/dev/null 2>&1; then
    wget --tries=5 -O "${PBF}" \
      "https://download.geofabrik.de/${REGION}-latest.osm.pbf"
  elif command -v curl >/dev/null 2>&1; then
    curl -fL --retry 5 --output "${PBF}" \
      "https://download.geofabrik.de/${REGION}-latest.osm.pbf"
  else
    echo "[osrm] ERROR: no wget or curl in the image" >&2
    exit 1
  fi
fi

if [ ! -f "${OSRM_BASE}.fileIndex" ]; then
  echo "[osrm] osrm-extract (foot profile)"
  osrm-extract -p "${PROFILE}" "${PBF}"
  echo "[osrm] osrm-contract"
  osrm-contract "${OSRM_BASE}"
fi

echo "[osrm] osrm-routed listening on :5000"
# OSRM's default --max-table-size is 100, which trips the tour planner's
# cluster-discovery /table call (we send the full candidate pool, capped at
# 300 in GreedyTspPlanner). Override via env if you ever push the pool higher.
MAX_TABLE_SIZE="${OSRM_MAX_TABLE_SIZE:-5000}"
exec osrm-routed --algorithm CH --port 5000 --max-table-size "${MAX_TABLE_SIZE}" "${OSRM_BASE}"
