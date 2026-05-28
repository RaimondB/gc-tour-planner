# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# One-shot landuse-import image for gc-tour-planner (ADR-0009).
#
# osm2pgsql + osmium-tool + the psql client, all from Ubuntu's apt
# repositories. Building from source would be overkill — Ubuntu ships
# osm2pgsql 2.x and osmium-tool 1.16+ which is everything we need.
#
# The container runs once on compose-up, imports landuse polygons from the
# shared OSRM PBF, writes a metadata row, and exits 0. Subsequent boots
# short-circuit on the metadata row (see bootstrap.sh).

FROM ubuntu:24.04

# Base packages:
#   - osm2pgsql: the importer itself
#   - osmium-tool: used by bootstrap.sh to read PBF metadata for
#     landuse_import_meta.pbf_timestamp
#   - postgresql-client: for the bootstrap.sh psql calls
# --no-install-recommends keeps the image small (~120 MB total).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        osm2pgsql \
        osmium-tool \
        postgresql-client \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Persistent location for osm2pgsql's --flat-nodes file across re-imports.
# Mounted via the osm2pgsql-data named volume in compose.
RUN mkdir -p /var/lib/osm2pgsql

COPY osm-features.lua /srv/osm-features.lua
COPY bootstrap.sh     /srv/bootstrap.sh
RUN chmod +x /srv/bootstrap.sh

ENTRYPOINT ["/srv/bootstrap.sh"]
