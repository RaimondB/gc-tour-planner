// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Tours } from "@gctp/shared";
import { DatabaseModule } from "../database/database.module.js";
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
import { AdventureLabModule } from "../sources/adventure-lab/adventure-lab.module.js";
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
import { GREEDY_PLANNER, SOLVER_PLANNER } from "./planner.tokens.js";
import { ToursController } from "./tours.controller.js";
import { ToursService } from "./tours.service.js";
import { SavedToursController } from "./saved-tours.controller.js";
import { SavedToursService } from "./saved-tours.service.js";
import { SavedToursRepository } from "./saved-tours.repository.js";

/**
 * Both Pass-2 planners are always instantiated and exposed under their own
 * tokens so `ToursService` can pick per request (greedy by default; the Timefold
 * solver when Adventure Labs are in scope, FR-I16). The greedy planner also
 * serves Pass-1 discovery for both. `Tours.TOUR_PLANNER` is kept (resolving to
 * greedy or solver per `TOUR_PLANNER` env) for the discovery bench scripts.
 */
const greedyPlannerProvider: Provider = {
  provide: GREEDY_PLANNER,
  useFactory: (
    caches: CachesService,
    cachesRepo: CachesRepository,
    cacheLanduse: CacheLanduseRepository,
    routing: RoutingService,
    routingRepo: RoutingRepository,
    osrm: OsrmClient,
    osrmVersion: OsrmVersionService,
    parkingFacilities: ParkingFacilitiesRepository,
    carRoads: CarRoadsRepository,
    landuseProfiles: LanduseProfilesRepository,
    computePool: ComputePool,
  ) =>
    new GreedyTspPlanner(
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
    ),
  inject: [
    CachesService,
    CachesRepository,
    CacheLanduseRepository,
    RoutingService,
    RoutingRepository,
    OSRM_CLIENT,
    OsrmVersionService,
    ParkingFacilitiesRepository,
    CarRoadsRepository,
    LanduseProfilesRepository,
    COMPUTE_POOL,
  ],
};

const solverPlannerProvider: Provider = {
  provide: SOLVER_PLANNER,
  useFactory: (
    greedy: GreedyTspPlanner,
    caches: CachesService,
    routing: RoutingService,
    osrm: OsrmClient,
    solver: SolverClient,
    parkingFacilities: ParkingFacilitiesRepository,
  ) =>
    new SolverTourPlanner(
      greedy,
      caches,
      routing,
      osrm,
      solver,
      parkingFacilities,
    ),
  inject: [
    GREEDY_PLANNER,
    CachesService,
    RoutingService,
    OSRM_CLIENT,
    SOLVER_CLIENT,
    ParkingFacilitiesRepository,
  ],
};

const tourPlannerProvider: Provider = {
  provide: Tours.TOUR_PLANNER,
  useFactory: (
    config: ConfigService,
    greedy: GreedyTspPlanner,
    solver: SolverTourPlanner,
  ) =>
    (config.get<string>("TOUR_PLANNER") ?? "greedy") === "solver"
      ? solver
      : greedy,
  inject: [ConfigService, GREEDY_PLANNER, SOLVER_PLANNER],
};

@Module({
  imports: [
    DatabaseModule,
    CachesModule,
    RoutingModule,
    OsmModule,
    LanduseProfilesModule,
    AdventureLabModule,
  ],
  controllers: [ToursController, SavedToursController],
  providers: [
    ToursService,
    SavedToursService,
    SavedToursRepository,
    { provide: SOLVER_CLIENT, useClass: HttpSolverClient },
    { provide: COMPUTE_POOL, useClass: PiscinaComputePool },
    greedyPlannerProvider,
    solverPlannerProvider,
    tourPlannerProvider,
  ],
  exports: [Tours.TOUR_PLANNER, ToursService],
})
export class ToursModule {}
