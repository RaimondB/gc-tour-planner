#!/usr/bin/env bash
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Stop the dev infra compose project (project=gctp-dev). Preserves volumes
# (pgdata-dev, valkey-data-dev, osrm-data-dev) so re-running scripts/dev.sh
# boots back fast. To also wipe data:
#   docker compose -p gctp-dev -f infra/docker-compose.dev.yml down -v
#
# This NEVER touches the UAT compose project (gctp) — that's a separate
# project name with separate volumes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$ROOT/infra"
DEV_COMPOSE="$INFRA/docker-compose.dev.yml"
DEV_PROJECT="gctp-dev"

echo "→ Stopping dev infra (project=$DEV_PROJECT, volumes preserved)"
docker compose -p "$DEV_PROJECT" -f "$DEV_COMPOSE" down
