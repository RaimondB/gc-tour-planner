// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";
import {
  ParkingAccessChip,
  ParkingFeeFilter,
} from "../parking-facilities/index.js";
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
  /**
   * Per-stage visit time for Adventure Lab stages, used instead of
   * `timePerCacheMinutes` for `type==='Adventure Lab'` stops. Labs are quick
   * (answer a question on your phone) and several often sit at one spot, so a
   * separate, smaller default (2 min) keeps tour-time estimates realistic.
   */
  alStageVisitMinutes: z.number().int().nonnegative().max(120).default(2),
  /**
   * FR-SF7: extra minutes added per cache that needs a tool (climbing
   * gear, scuba, fishing rod, etc. — see `hasToolRequirement` in
   * `packages/shared/src/caches/attributes.ts`). Default 5 min covers
   * the typical "unpack equipment, get to the right spot" overhead.
   * Bumps `result.totals.visitMinutes` only; doesn't affect planning
   * (distance budget, parking selection, leg picking).
   */
  toolBonusMinutes: z.number().int().nonnegative().max(60).default(5),
  startPreference: StartPreference.default("auto"),
  userSuppliedStart: LngLat.optional(),
  /**
   * Pass-1 link cap, re-supplied for Pass 2 so the parking selection can
   * apply the same "is this parking actually walkable?" rule the cluster
   * discovery used (ADR-0011). Defaults to the same 1500 m as PlanInput.
   */
  maxLinkMeters: z.number().int().min(200).max(5000).default(1500),
  /**
   * Post-leg-pick fringe trim threshold (m). After the loop-aware leg
   * picker has had its chance to find a non-fringe alternative route,
   * any cache whose `leg-in + leg-out - skip-distance` (i.e. the extra
   * walking it costs to visit) exceeds this gets dropped and the legs
   * are rebuilt on the smaller set. Separate from `maxLinkMeters` so the
   * user can be aggressive about fringes without disturbing clustering.
   */
  fringeTrimMeters: z.number().int().min(100).max(3000).default(500),
  /**
   * Applies only when `startPreference === "osm-parking"`. See PlanInput
   * for the full rationale on `permit` being opt-in.
   */
  osmParkingAccessFilter: z
    .array(ParkingAccessChip)
    .default(["yes", "customers"]),
  osmParkingFeeFilter: ParkingFeeFilter.default("any"),
});
export type PlanLoopInput = z.infer<typeof PlanLoopInput>;
