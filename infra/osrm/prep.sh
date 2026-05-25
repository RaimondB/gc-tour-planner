#!/bin/sh
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# One-shot OSM prep: download Geofabrik PBF extract(s) and, when more than
# one region is requested, merge them with `osmium merge` so OSRM can extract
# a single contiguous foot graph.
#
# Runs in a separate Debian-based container because `osmium-tool` is not in
# alpine community (verified against 3.21 stable + edge). The OSRM container
# stays on the upstream alpine image and just consumes the prepared PBF from
# the shared `osrm-data` volume.
#
# Required env: OSRM_REGIONS (preferred) or OSRM_REGION. Multiple regions
# come in comma- or space-separated.
# Volume:       /data is the same `osrm-data` named volume OSRM mounts.

set -eu

# Resolve the region list (same logic as OSRM's bootstrap.sh — keep in sync).
if [ -n "${OSRM_REGIONS:-}" ]; then
  REGION_LIST="${OSRM_REGIONS}"
elif [ -n "${OSRM_REGION:-}" ]; then
  REGION_LIST="${OSRM_REGION}"
else
  echo "[osm-prep] ERROR: OSRM_REGIONS (or OSRM_REGION) must be set" >&2
  exit 1
fi

REGIONS=$(echo "${REGION_LIST}" | tr ',' ' ' | tr -s ' ')
REGION_COUNT=$(echo "${REGIONS}" | wc -w)
DATA_DIR="/data"

if [ "${REGION_COUNT}" -eq 1 ]; then
  TARGET_PBF="${DATA_DIR}/$(echo "${REGIONS}" | tr '/' '-')-latest.osm.pbf"
else
  SLUG=$(echo "${REGIONS}" | tr ' ' '\n' | sed 's|/|-|g' | paste -sd+ -)
  TARGET_PBF="${DATA_DIR}/merged-${SLUG}-latest.osm.pbf"
fi

# Fast path: target already present (re-run after first boot, or no-op pick
# up). Skip everything including the apt install.
if [ -f "${TARGET_PBF}" ]; then
  echo "[osm-prep] target already present: ${TARGET_PBF}"
  exit 0
fi

mkdir -p "${DATA_DIR}"

echo "[osm-prep] installing osmium-tool + wget (first boot only)"
# DEBIAN_FRONTEND=noninteractive suppresses debconf's "TERM is not set"
# fallback chatter when apt runs without a TTY. Purely cosmetic; doesn't
# change what gets installed.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  osmium-tool wget ca-certificates
rm -rf /var/lib/apt/lists/*

# Download each region's PBF if absent.
for r in ${REGIONS}; do
  out="${DATA_DIR}/$(echo "${r}" | tr '/' '-')-latest.osm.pbf"
  if [ -f "${out}" ]; then
    echo "[osm-prep] cached: ${out}"
    continue
  fi
  echo "[osm-prep] downloading: ${r}"
  mkdir -p "$(dirname "${out}")"
  wget --tries=5 -O "${out}" \
    "https://download.geofabrik.de/${r}-latest.osm.pbf"
done

if [ "${REGION_COUNT}" -eq 1 ]; then
  # Single region — no merge needed; downloaded file IS the target.
  echo "[osm-prep] single region — no merge"
  exit 0
fi

# Multi-region merge. osmium merge deduplicates elements that appear in both
# inputs (e.g. border ways in a country-extract + a state-extract), which is
# what we want.
set --
for r in ${REGIONS}; do
  set -- "$@" "${DATA_DIR}/$(echo "${r}" | tr '/' '-')-latest.osm.pbf"
done
echo "[osm-prep] merging ${REGION_COUNT} extracts into ${TARGET_PBF}"
# --overwrite covers the edge case where a previous run was interrupted
# mid-write and left a partial file behind.
osmium merge --overwrite -o "${TARGET_PBF}" "$@"
echo "[osm-prep] done"
