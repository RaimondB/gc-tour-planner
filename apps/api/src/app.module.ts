// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminLanduseModule } from "./admin/landuse/admin-landuse.module.js";
import { AdminPrecomputeModule } from "./admin/precompute/admin-precompute.module.js";
import { AdminUploadsModule } from "./admin/uploads/admin-uploads.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CachesModule } from "./caches/caches.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { GpxModule } from "./gpx/gpx.module.js";
import { HealthModule } from "./health/health.module.js";
import { LanduseProfilesModule } from "./landuse-profiles/landuse-profiles.module.js";
import { OsmModule } from "./osm/osm.module.js";
import { WalkingPrecomputeModule } from "./jobs/walking-precompute/walking-precompute.module.js";
import { PrecomputeStateModule } from "./precompute-state/precompute-state.module.js";
import { QueueModule } from "./queues/queue.module.js";
import { RoutingModule } from "./routing/routing.module.js";
import { ToursModule } from "./tours/tours.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    QueueModule,
    PrecomputeStateModule,
    AuthModule,
    HealthModule,
    GpxModule,
    CachesModule,
    OsmModule,
    LanduseProfilesModule,
    RoutingModule,
    ToursModule,
    WalkingPrecomputeModule,
    AdminPrecomputeModule,
    AdminLanduseModule,
    AdminUploadsModule,
  ],
})
export class AppModule {}
