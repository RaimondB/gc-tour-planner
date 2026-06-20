// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * DI tokens for the two concrete Pass-2 planners. Both are always instantiated;
 * `ToursService` picks per request (greedy by default, the Timefold solver when
 * Adventure Labs are in scope — see FR-I16). The legacy `Tours.TOUR_PLANNER`
 * token still resolves to one of them for the discovery benches.
 */
export const GREEDY_PLANNER = Symbol.for("@gctp/api/tours/GREEDY_PLANNER");
export const SOLVER_PLANNER = Symbol.for("@gctp/api/tours/SOLVER_PLANNER");
