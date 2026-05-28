#!/bin/sh
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# OSRM container entrypoint. Assumes the target PBF is already on /data —
# the `osm-prep` compose service downloads + (when multi-region) merges
# extracts before this container is allowed to start.
#
# Why prep is in a separate container: `osmium-tool` isn't in alpine
# community (the upstream osrm-backend image is alpine), so multi-region
# merge happens in a Debian-based one-shot service. See osrm/prep.sh.
#
# Required env (one of, kept in sync with osm-prep):
#   OSRM_REGIONS  (preferred) — comma- or space-separated Geofabrik regions.
#   OSRM_REGION   (legacy)    — single region.

set -eu

if [ -n "${OSRM_REGIONS:-}" ]; then
  REGION_LIST="${OSRM_REGIONS}"
elif [ -n "${OSRM_REGION:-}" ]; then
  REGION_LIST="${OSRM_REGION}"
else
  echo "[osrm] ERROR: OSRM_REGIONS (or OSRM_REGION) must be set" >&2
  exit 1
fi

DATA_DIR="/data"
PROFILE="/opt/foot.lua"

REGIONS=$(echo "${REGION_LIST}" | tr ',' ' ' | tr -s ' ')
REGION_COUNT=$(echo "${REGIONS}" | wc -w)

# Path-resolution must match osm-prep.sh exactly.
if [ "${REGION_COUNT}" -eq 1 ]; then
  TARGET_PBF="${DATA_DIR}/$(echo "${REGIONS}" | tr '/' '-')-latest.osm.pbf"
else
  SLUG=$(echo "${REGIONS}" | tr ' ' '\n' | sed 's|/|-|g' | paste -sd+ -)
  TARGET_PBF="${DATA_DIR}/merged-${SLUG}-latest.osm.pbf"
fi
OSRM_BASE="${TARGET_PBF%.osm.pbf}.osrm"

if [ ! -f "${TARGET_PBF}" ]; then
  echo "[osrm] ERROR: ${TARGET_PBF} missing — osm-prep should have produced it." >&2
  echo "[osrm]        Inspect with: docker compose logs osm-prep" >&2
  exit 1
fi

# MLD (Multi-Level Dijkstra) instead of CH: ~2-3 GiB peak preprocess vs 6-8
# GiB for CH contraction on NL-foot. CH OOM-killed us on the 16 GiB host; MLD
# fits comfortably inside the 4 GiB container cap. The trade-off is slightly
# slower /table queries on very large matrices, which is fine for our cluster
# discovery sizes (≤ 300×300).
#
# Readiness probe: .partition + .cell_metrics are the MLD-specific outputs.
# If either is missing we redo extract + partition + customize. Re-running
# extract is idempotent (overwrites .osrm.*) and cheap (~4 min on NL).
if [ ! -f "${OSRM_BASE}.partition" ] || [ ! -f "${OSRM_BASE}.cell_metrics" ]; then
  echo "[osrm] osrm-extract (foot profile) on ${TARGET_PBF}"
  osrm-extract -p "${PROFILE}" "${TARGET_PBF}"
  echo "[osrm] osrm-partition"
  osrm-partition "${OSRM_BASE}"
  echo "[osrm] osrm-customize"
  osrm-customize "${OSRM_BASE}"
fi

# Publish a stable identifier for the live extract so route_legs rows can be
# tagged with it and any leftovers from a previous extract are ignored on
# read. Short sha256 of the PBF is deterministic, cheap (PBF is local), and
# changes only when the operator pulls a new Geofabrik extract. Written
# every boot so a manual file delete self-heals on the next start.
VERSION_FILE="${DATA_DIR}/osrm-version.txt"
sha256sum "${TARGET_PBF}" | cut -c1-16 > "${VERSION_FILE}"
echo "[osrm] extract version $(cat "${VERSION_FILE}") -> ${VERSION_FILE}"

echo "[osrm] osrm-routed listening on :5000 (MLD)"
# OSRM's default --max-table-size is 100, which trips the tour planner's
# cluster-discovery /table call (we send the full candidate pool, capped at
# 2000 in GreedyTspPlanner). Override via env if you ever push the pool higher.
MAX_TABLE_SIZE="${OSRM_MAX_TABLE_SIZE:-5000}"
# Worker thread count for osrm-routed. Defaults to the number of hardware
# threads, which can pin the box under load. NUC8i7BEH is 4C/8T; 4 is a
# sane middle (leaves headroom for postgres + api + the osm2pgsql-import
# container if it ever runs concurrently). Pair with the API-side
# OSRM_MAX_CONCURRENCY cap (HttpOsrmClient) — that bounds inbound, this
# bounds parallelism per request inside OSRM.
OSRM_THREADS="${OSRM_THREADS:-4}"
exec osrm-routed --algorithm MLD --port 5000 \
  --max-table-size "${MAX_TABLE_SIZE}" \
  --threads "${OSRM_THREADS}" \
  "${OSRM_BASE}"
