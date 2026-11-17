// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { CachesModule } from "../caches/caches.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { LanduseProfilesModule } from "../landuse-profiles/landuse-profiles.module.js";
import { RoutingModule } from "../routing/routing.module.js";
import { ToursModule } from "../tours/tours.module.js";
import { WalksController } from "./walks.controller.js";
import { WalksService } from "./walks.service.js";

/** Ad-hoc walk replanning (ADR-0040, FR-T18). */
@Module({
  imports: [
    DatabaseModule,
    CachesModule,
    LanduseProfilesModule,
    RoutingModule,
    ToursModule,
  ],
  controllers: [WalksController],
  providers: [WalksService],
})
export class WalksModule {}
