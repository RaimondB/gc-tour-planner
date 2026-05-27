// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module.js";
import { OsmModule } from "../../osm/osm.module.js";
import { AdminLanduseController } from "./admin-landuse.controller.js";
import { AdminLanduseService } from "./admin-landuse.service.js";

/**
 * Admin endpoints for the osm2pgsql landuse pipeline (ADR-0009 +
 * ADR-0010 simplification). Read-only status only. Wired into AppModule.
 */
@Module({
  imports: [DatabaseModule, OsmModule],
  controllers: [AdminLanduseController],
  providers: [AdminLanduseService],
})
export class AdminLanduseModule {}
