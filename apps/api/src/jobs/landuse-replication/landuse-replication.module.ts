// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module.js";
import { OsmModule } from "../../osm/osm.module.js";
import { LanduseReplicationProcessor } from "./landuse-replication.processor.js";
import { LanduseReplicationScheduler } from "./landuse-replication.scheduler.js";

/**
 * Daily Geofabrik-diff replication for `landuse_polygons` (ADR-0009).
 *
 * Components:
 *   - {@link LanduseReplicationProcessor} — BullMQ worker that runs
 *     `osm2pgsql-replication update` inside the osm2pgsql-import container
 *     (or against a local binary if installed). Acquires a Postgres
 *     advisory lock so concurrent enqueues serialise.
 *   - {@link LanduseReplicationScheduler} — registers a daily repeatable
 *     job at 04:00 host time. Idempotent on registration so deploys don't
 *     duplicate the schedule.
 */
@Module({
  imports: [DatabaseModule, OsmModule],
  providers: [LanduseReplicationProcessor, LanduseReplicationScheduler],
})
export class LanduseReplicationModule {}
