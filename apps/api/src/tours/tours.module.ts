// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Tours } from "@gctp/shared";
import { CachesModule } from "../caches/caches.module.js";
import { CachesService } from "../caches/caches.service.js";
import { RoutingModule } from "../routing/routing.module.js";
import { RoutingService } from "../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../routing/osrm.client.js";
import { GreedyTspPlanner } from "./strategies/greedy/greedy-tsp-planner.js";
import { ToursController } from "./tours.controller.js";
import { ToursService } from "./tours.service.js";

const tourPlannerProvider: Provider = {
  provide: Tours.TOUR_PLANNER,
  useFactory: (
    config: ConfigService,
    caches: CachesService,
    routing: RoutingService,
    osrm: OsrmClient,
  ) => {
    // Only one strategy lives in M5-α. The `solver` branch from ADR-0002 is
    // wired here as soon as `SolverTourPlanner` ships.
    const flavor = config.get<string>("TOUR_PLANNER") ?? "greedy";
    switch (flavor) {
      case "greedy":
      default:
        return new GreedyTspPlanner(caches, routing, osrm);
    }
  },
  inject: [ConfigService, CachesService, RoutingService, OSRM_CLIENT],
};

@Module({
  imports: [CachesModule, RoutingModule],
  controllers: [ToursController],
  providers: [ToursService, tourPlannerProvider],
  exports: [Tours.TOUR_PLANNER, ToursService],
})
export class ToursModule {}
