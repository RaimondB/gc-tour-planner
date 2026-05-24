#!/usr/bin/env bash
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# OSRM container entrypoint. Downloads + preprocesses the configured region's
# OSM extract on first boot, then runs osrm-routed against the contracted graph.
#
# Required env: OSRM_REGION (e.g. "europe/netherlands").
# Volume:       /data is persisted as the `osrm-data` named volume.

set -euo pipefail

REGION="${OSRM_REGION:?OSRM_REGION must be set, e.g. europe/netherlands}"
DATA_DIR="/data"
PROFILE="/opt/foot.lua"
PBF="${DATA_DIR}/${REGION//\//-}-latest.osm.pbf"
OSRM_BASE="${PBF%.osm.pbf}.osrm"

mkdir -p "${DATA_DIR}"

if [[ ! -f "${PBF}" ]]; then
  echo "[osrm] downloading extract: ${REGION}"
  mkdir -p "$(dirname "${PBF}")"
  curl -fL --retry 5 --output "${PBF}" \
    "https://download.geofabrik.de/${REGION}-latest.osm.pbf"
fi

if [[ ! -f "${OSRM_BASE}.fileIndex" ]]; then
  echo "[osrm] osrm-extract (foot profile)"
  osrm-extract -p "${PROFILE}" "${PBF}"
  echo "[osrm] osrm-contract"
  osrm-contract "${OSRM_BASE}"
fi

echo "[osrm] osrm-routed listening on :5000"
exec osrm-routed --algorithm CH --port 5000 "${OSRM_BASE}"
