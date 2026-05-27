// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { LanduseRepository } from "./landuse.repository.js";
import { OsmController } from "./osm.controller.js";
import { OsmService } from "./osm.service.js";

/**
 * Read-only landuse module (ADR-0009). Writes happen out-of-band via
 * osm2pgsql; this module exposes `LanduseRepository` and `OsmService` for
 * the rest of the API to consume.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [OsmController],
  providers: [OsmService, LanduseRepository],
  exports: [OsmService, LanduseRepository],
})
export class OsmModule {}
