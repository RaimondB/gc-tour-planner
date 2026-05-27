// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module.js";
import { OsmModule } from "../../osm/osm.module.js";
import { QUEUE_LANDUSE_REPLICATION } from "../../queues/queue.tokens.js";
import { AdminLanduseController } from "./admin-landuse.controller.js";
import { AdminLanduseService } from "./admin-landuse.service.js";

/**
 * Admin endpoints for the osm2pgsql landuse pipeline (ADR-0009).
 * Wired into AppModule.
 */
@Module({
  imports: [
    DatabaseModule,
    OsmModule,
    BullModule.registerQueue({ name: QUEUE_LANDUSE_REPLICATION }),
  ],
  controllers: [AdminLanduseController],
  providers: [AdminLanduseService],
})
export class AdminLanduseModule {}
