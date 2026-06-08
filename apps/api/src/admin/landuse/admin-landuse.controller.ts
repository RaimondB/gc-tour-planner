// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Admin } from "@gctp/shared";
import { AdminGuard } from "../../auth/admin.guard.js";
import { AdminLanduseService } from "./admin-landuse.service.js";

/**
 * Admin surface for the osm2pgsql landuse pipeline (ADR-0009 + ADR-0010
 * simplification). Read-only — refreshes are operator-driven via the
 * `scripts/refresh-osm-data.sh` host script, kept in lockstep with OSRM.
 *
 * Gated by the global auth guard (session) plus `AdminGuard`: requires
 * `users.is_admin` (FR-P12), not merely a logged-in user.
 */
@ApiTags("admin")
@UseGuards(AdminGuard)
@Controller("admin/landuse")
export class AdminLanduseController {
  constructor(private readonly service: AdminLanduseService) {}

  @Get("status")
  @ApiOperation({
    summary: "Last import health for landuse_polygons",
  })
  @ApiResponse({ status: 200, description: "Landuse pipeline status." })
  async status(): Promise<Admin.LanduseStatus> {
    return this.service.status();
  }
}
