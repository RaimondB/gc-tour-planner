// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import { Tours } from "@gctp/shared";

@Injectable()
export class ToursService {
  constructor(
    @Inject(Tours.TOUR_PLANNER)
    private readonly planner: Tours.TourPlannerStrategy,
  ) {}

  discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    return this.planner.discoverClusters(ownerId, input);
  }

  planLoop(
    ownerId: string,
    input: Tours.PlanLoopInput,
  ): Promise<Tours.PlanResult> {
    return this.planner.planLoop(ownerId, input);
  }
}
