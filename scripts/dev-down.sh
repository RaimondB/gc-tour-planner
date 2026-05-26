#!/usr/bin/env bash
# Copyright (C) 2026 Raimond Brookman and contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Stop the local dev infra (postgres, valkey, osrm, anything else compose
# brought up). Preserves volumes — re-running scripts/dev.sh boots back
# fast. To also wipe data:  cd infra && docker compose down -v

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$ROOT/infra"

echo "→ Stopping infra (volumes preserved)"
(cd "$INFRA" && docker compose down)
