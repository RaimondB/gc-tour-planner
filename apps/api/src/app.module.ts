// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module.js";
import { CachesModule } from "./caches/caches.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { GpxModule } from "./gpx/gpx.module.js";
import { HealthModule } from "./health/health.module.js";
import { OsmModule } from "./osm/osm.module.js";
import { RoutingModule } from "./routing/routing.module.js";
import { ToursModule } from "./tours/tours.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    GpxModule,
    CachesModule,
    OsmModule,
    RoutingModule,
    ToursModule,
  ],
})
export class AppModule {}
