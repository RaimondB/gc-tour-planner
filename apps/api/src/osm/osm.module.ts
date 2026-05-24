// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { OsmController } from "./osm.controller.js";
import { OsmRepository } from "./osm.repository.js";
import { OsmService } from "./osm.service.js";
import { HttpOverpassClient, OVERPASS_CLIENT } from "./overpass.client.js";

@Module({
  imports: [DatabaseModule],
  controllers: [OsmController],
  providers: [
    OsmService,
    OsmRepository,
    { provide: OVERPASS_CLIENT, useClass: HttpOverpassClient },
  ],
  exports: [OsmService],
})
export class OsmModule {}
