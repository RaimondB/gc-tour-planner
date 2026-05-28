// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { LanduseRepository } from "./landuse.repository.js";
import { OsmController } from "./osm.controller.js";
import { OsmService } from "./osm.service.js";
import { ParkingFacilitiesController } from "./parking-facilities.controller.js";
import { ParkingFacilitiesRepository } from "./parking-facilities.repository.js";

/**
 * Read-only OSM module (ADR-0009 + ADR-0011). Writes happen out-of-band
 * via a single osm2pgsql pass that populates both `landuse_polygons` and
 * `parking_facilities`. This module exposes the repositories + `OsmService`
 * for the rest of the API to consume.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [OsmController, ParkingFacilitiesController],
  providers: [OsmService, LanduseRepository, ParkingFacilitiesRepository],
  exports: [OsmService, LanduseRepository, ParkingFacilitiesRepository],
})
export class OsmModule {}
