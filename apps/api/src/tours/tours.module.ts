// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Tours } from "@gctp/shared";
import { CachesModule } from "../caches/caches.module.js";
import { CachesRepository } from "../caches/caches.repository.js";
import { CachesService } from "../caches/caches.service.js";
import { CacheLanduseRepository } from "../caches/cache-landuse.repository.js";
import { OsmModule } from "../osm/osm.module.js";
import { LanduseProfilesModule } from "../landuse-profiles/landuse-profiles.module.js";
import { LanduseProfilesRepository } from "../landuse-profiles/landuse-profiles.repository.js";
import { ParkingFacilitiesRepository } from "../osm/parking-facilities.repository.js";
import { CarRoadsRepository } from "../osm/car-roads.repository.js";
import { RoutingModule } from "../routing/routing.module.js";
import { RoutingRepository } from "../routing/routing.repository.js";
import { RoutingService } from "../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../routing/osrm.client.js";
import { OsrmVersionService } from "../routing/osrm-version.service.js";
import { GreedyTspPlanner } from "./strategies/greedy/greedy-tsp-planner.js";
import { SolverTourPlanner } from "./strategies/solver/solver-tour-planner.js";
import {
  COMPUTE_POOL,
  type ComputePool,
  PiscinaComputePool,
} from "./compute/compute-pool.service.js";
import {
  HttpSolverClient,
  SOLVER_CLIENT,
  type SolverClient,
} from "./strategies/solver/solver-client.js";
import { ToursController } from "./tours.controller.js";
import { ToursService } from "./tours.service.js";

/**
 * Strategy factory.
 *
 * `TOUR_PLANNER=greedy` (default): pure-TS GreedyTspPlanner.
 * `TOUR_PLANNER=solver`:           SolverTourPlanner, which delegates Pass 1
 *                                  to the greedy planner and POSTs Pass 2 to
 *                                  the Timefold sidecar (SOLVER_URL).
 *
 * Both strategies always have their dependencies instantiated — the factory
 * just picks which is returned. This keeps the wiring trivial and lets us
 * promote the greedy planner to a discoverClusters delegate without juggling
 * provider scopes.
 */
const tourPlannerProvider: Provider = {
  provide: Tours.TOUR_PLANNER,
  useFactory: (
    config: ConfigService,
    caches: CachesService,
    cachesRepo: CachesRepository,
    cacheLanduse: CacheLanduseRepository,
    routing: RoutingService,
    routingRepo: RoutingRepository,
    osrm: OsrmClient,
    osrmVersion: OsrmVersionService,
    solver: SolverClient,
    parkingFacilities: ParkingFacilitiesRepository,
    carRoads: CarRoadsRepository,
    landuseProfiles: LanduseProfilesRepository,
    computePool: ComputePool,
  ) => {
    const greedy = new GreedyTspPlanner(
      caches,
      cachesRepo,
      cacheLanduse,
      routing,
      routingRepo,
      osrm,
      osrmVersion,
      parkingFacilities,
      carRoads,
      landuseProfiles,
      computePool,
    );
    const flavor = config.get<string>("TOUR_PLANNER") ?? "greedy";
    switch (flavor) {
      case "solver":
        return new SolverTourPlanner(
          greedy,
          caches,
          routing,
          osrm,
          solver,
          parkingFacilities,
        );
      case "greedy":
      default:
        return greedy;
    }
  },
  inject: [
    ConfigService,
    CachesService,
    CachesRepository,
    CacheLanduseRepository,
    RoutingService,
    RoutingRepository,
    OSRM_CLIENT,
    OsrmVersionService,
    SOLVER_CLIENT,
    ParkingFacilitiesRepository,
    CarRoadsRepository,
    LanduseProfilesRepository,
    COMPUTE_POOL,
  ],
};

@Module({
  imports: [CachesModule, RoutingModule, OsmModule, LanduseProfilesModule],
  controllers: [ToursController],
  providers: [
    ToursService,
    { provide: SOLVER_CLIENT, useClass: HttpSolverClient },
    { provide: COMPUTE_POOL, useClass: PiscinaComputePool },
    tourPlannerProvider,
  ],
  exports: [Tours.TOUR_PLANNER, ToursService],
})
export class ToursModule {}
