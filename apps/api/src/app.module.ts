// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminLanduseModule } from "./admin/landuse/admin-landuse.module.js";
import { AdminPrecomputeModule } from "./admin/precompute/admin-precompute.module.js";
import { AdminUploadsModule } from "./admin/uploads/admin-uploads.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ValkeyModule } from "./auth/valkey.module.js";
import { ValkeyThrottlerStorage } from "./auth/valkey-throttler.storage.js";
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
    ValkeyModule,
    // Per-IP rate limiting (FR-P9). Valkey-backed storage so the limit holds
    // across replicas; only routes that opt in via @UseGuards(ThrottlerGuard)
    // are throttled (the auth credential endpoints), not every request.
    ThrottlerModule.forRootAsync({
      imports: [ValkeyModule],
      inject: [ValkeyThrottlerStorage],
      useFactory: (storage: ValkeyThrottlerStorage) => ({
        throttlers: [{ name: "default", ttl: 60_000, limit: 60 }],
        storage,
      }),
    }),
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
