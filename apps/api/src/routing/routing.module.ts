// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { HttpOsrmClient, OSRM_CLIENT } from "./osrm.client.js";
import { RoutingController } from "./routing.controller.js";
import { RoutingRepository } from "./routing.repository.js";
import { RoutingService } from "./routing.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [RoutingController],
  providers: [
    RoutingService,
    RoutingRepository,
    { provide: OSRM_CLIENT, useClass: HttpOsrmClient },
  ],
  exports: [RoutingService, RoutingRepository, OSRM_CLIENT],
})
export class RoutingModule {}
