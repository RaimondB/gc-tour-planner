// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminAdventureLabsModule } from "./admin/adventure-labs/admin-adventure-labs.module.js";
import { AdventureLabsModule } from "./adventure-labs/adventure-labs.module.js";
import { AdminLanduseModule } from "./admin/landuse/admin-landuse.module.js";
import { AdminPrecomputeModule } from "./admin/precompute/admin-precompute.module.js";
import { AdminUploadsModule } from "./admin/uploads/admin-uploads.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { clientIp, trustCfFromEnv, type IpRequest } from "./auth/client-ip.js";
import { ValkeyModule } from "./auth/valkey.module.js";
import { ValkeyThrottlerStorage } from "./auth/valkey-throttler.storage.js";
import { CachesModule } from "./caches/caches.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { GpxModule } from "./gpx/gpx.module.js";
import { HealthModule } from "./health/health.module.js";
import { IngestModule } from "./ingest/ingest.module.js";
import { LanduseProfilesModule } from "./landuse-profiles/landuse-profiles.module.js";
import { OsmModule } from "./osm/osm.module.js";
import { AdventureLabImportModule } from "./jobs/adventure-lab-import/adventure-lab-import.module.js";
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
      useFactory: (storage: ValkeyThrottlerStorage) => {
        // Key the per-IP cap on the REAL client IP, not nginx's socket address
        // (FR-P9, Gate 1.1). Behind the CF tunnel use CF-Connecting-IP; otherwise
        // rely on Express `trust proxy` having resolved req.ip (see main.ts).
        const trustCf = trustCfFromEnv();
        return {
          throttlers: [{ name: "default", ttl: 60_000, limit: 60 }],
          storage,
          getTracker: (req: Record<string, unknown>) =>
            clientIp(req as unknown as IpRequest, {
              trustCfConnectingIp: trustCf,
            }),
        };
      },
    }),
    DatabaseModule,
    QueueModule,
    PrecomputeStateModule,
    AuthModule,
    HealthModule,
    GpxModule,
    IngestModule,
    CachesModule,
    OsmModule,
    LanduseProfilesModule,
    RoutingModule,
    ToursModule,
    WalkingPrecomputeModule,
    AdventureLabImportModule,
    AdventureLabsModule,
    AdminPrecomputeModule,
    AdminLanduseModule,
    AdminUploadsModule,
    AdminAdventureLabsModule,
  ],
})
export class AppModule {}
