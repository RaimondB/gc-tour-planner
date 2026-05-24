// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Temporary stub until M5 lands `GreedyTspPlanner`. The interface is real,
// the DI wiring is real, but calling .plan() before M5 throws explicitly so
// nothing silently returns an empty tour.

import { Injectable } from "@nestjs/common";
import type { Tours } from "@gctp/shared";

@Injectable()
export class NotImplementedPlanner implements Tours.TourPlannerStrategy {
  plan(_input: Tours.PlanInput): Promise<Tours.PlanResult> {
    throw new Error(
      "Tour planning is not implemented yet. The greedy planner lands in milestone M5 (see docs/REQUIREMENTS.md §Roadmap).",
    );
  }
}
