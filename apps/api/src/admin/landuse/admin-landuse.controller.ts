// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Admin } from "@gctp/shared";
import { AdminLanduseService } from "./admin-landuse.service.js";

/**
 * Admin surface for the osm2pgsql landuse pipeline (ADR-0009).
 * Gated by the existing dev-user middleware today; a real admin role
 * check lands when M6 auth ships.
 */
@ApiTags("admin")
@Controller("admin/landuse")
export class AdminLanduseController {
  constructor(private readonly service: AdminLanduseService) {}

  @Get("status")
  @ApiOperation({
    summary: "Last import + replication health for landuse_polygons",
  })
  @ApiResponse({ status: 200, description: "Landuse pipeline status." })
  async status(): Promise<Admin.LanduseStatus> {
    return this.service.status();
  }

  @Post("reimport")
  @ApiOperation({
    summary: "Enqueue a manual landuse-replication tick",
    description:
      "Updates the heartbeat on landuse_import_meta and exercises the " +
      "advisory-lock path. For a full re-import of the PBF, run " +
      "`LANDUSE_FORCE_REIMPORT=1 docker compose -p gctp run --rm " +
      "osm2pgsql-import` on the host.",
  })
  @ApiResponse({ status: 201, description: "Manual replication enqueued." })
  async reimport(): Promise<Admin.LanduseReimportResponse> {
    return this.service.enqueueReimport();
  }
}
