// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module.js";
import { PrecomputeStateModule } from "../../precompute-state/precompute-state.module.js";
import { RoutingModule } from "../../routing/routing.module.js";
import { AdminPrecomputeController } from "./admin-precompute.controller.js";
import { AdminPrecomputeService } from "./admin-precompute.service.js";

@Module({
  imports: [DatabaseModule, PrecomputeStateModule, RoutingModule],
  controllers: [AdminPrecomputeController],
  providers: [AdminPrecomputeService],
})
export class AdminPrecomputeModule {}
