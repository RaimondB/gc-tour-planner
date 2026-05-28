// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { LanduseProfilesController } from "./landuse-profiles.controller.js";
import { LanduseProfilesRepository } from "./landuse-profiles.repository.js";

/**
 * Saved landuse-weighted scoring profiles (M5-β). The planner reads from
 * the repository (via `ToursModule` importing it) to resolve a
 * `landuseProfileId` on a `PlanInput` into the kinds the cluster scoring
 * should reward.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [LanduseProfilesController],
  providers: [LanduseProfilesRepository],
  exports: [LanduseProfilesRepository],
})
export class LanduseProfilesModule {}
