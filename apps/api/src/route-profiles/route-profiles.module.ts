// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { LanduseProfilesModule } from "../landuse-profiles/landuse-profiles.module.js";
import { RouteProfilesController } from "./route-profiles.controller.js";
import { RouteProfilesRepository } from "./route-profiles.repository.js";
import { RouteProfilesService } from "./route-profiles.service.js";

/** Route profiles (FR-T19, ADR-0039): saved planning presets. */
@Module({
  imports: [DatabaseModule, LanduseProfilesModule],
  controllers: [RouteProfilesController],
  providers: [RouteProfilesRepository, RouteProfilesService],
  exports: [RouteProfilesRepository],
})
export class RouteProfilesModule {}
