// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";
import { StartPreference } from "./plan-input.js";

/**
 * Pass 2 input: turn a user-chosen cluster (a set of cache ids picked from
 * `/tours/clusters` candidates) into a routed closed loop.
 *
 * The cache-id list is the source of truth for which caches belong in the
 * loop — the planner does not re-run cluster discovery here. Distance budget
 * is still honored as a soft trim: caches are admitted in soft-score order
 * until the running MST lower bound exceeds the budget. If every cache fits,
 * none are dropped.
 */
export const PlanLoopInput = z.object({
  cacheIds: z.array(z.number().int().positive()).min(2).max(50),
  distanceBudgetMeters: z.number().int().positive().max(25_000).default(8_000),
  timeBudgetMinutes: z.number().int().positive().max(720).optional(),
  /** Per-cache visit time used in time-budget math. Default per FR-T3 = 5. */
  timePerCacheMinutes: z.number().int().nonnegative().max(120).default(5),
  startPreference: StartPreference.default("parking-waypoint"),
  userSuppliedStart: LngLat.optional(),
});
export type PlanLoopInput = z.infer<typeof PlanLoopInput>;
