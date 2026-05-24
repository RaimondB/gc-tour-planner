// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Tours } from "@gctp/shared";
import { NotImplementedPlanner } from "./strategies/not-implemented-planner.js";

const tourPlannerProvider: Provider = {
  provide: Tours.TOUR_PLANNER,
  useFactory: (_config: ConfigService) => {
    // M5 will switch on _config.get<string>('TOUR_PLANNER') and return
    //   - 'greedy' (default): new GreedyTspPlanner(...)
    //   - 'solver': new SolverTourPlanner(...)
    // See docs/adr/0002-planner-strategy-interface.md.
    return new NotImplementedPlanner();
  },
  inject: [ConfigService],
};

@Module({
  providers: [tourPlannerProvider],
  exports: [Tours.TOUR_PLANNER],
})
export class ToursModule {}
