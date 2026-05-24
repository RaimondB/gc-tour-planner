// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PlanInput } from "./plan-input.js";
import type { PlanResult } from "./plan-result.js";

/**
 * Pluggable tour-planning strategy. See ADR-0002.
 *
 * MVP implementation: `GreedyTspPlanner` in apps/api/src/tours/strategies/greedy/.
 * Future implementation: `SolverTourPlanner` calling a sidecar (Timefold / OR-Tools).
 *
 * Strategies must be deterministic — same input produces same output.
 */
export interface TourPlannerStrategy {
  plan(input: PlanInput): Promise<PlanResult>;
}

/** DI token shared between NestJS modules and tests. */
export const TOUR_PLANNER = Symbol.for("@gctp/tours/TOUR_PLANNER");
export type TourPlannerToken = typeof TOUR_PLANNER;
