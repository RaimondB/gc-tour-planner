// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, LngLat } from "../geo/index.js";
import { RouteProfileSettings } from "../route-profiles/index.js";

/**
 * Ad-hoc walk replanning (ADR-0040, FR-T18). Stateless: the client sends the
 * whole walk state on every call and the server stores nothing about the walk.
 * The position and return point are used for this request only (ADR-0037
 * amendment).
 */

const CacheIds = z.array(z.number().int().positive()).max(500).default([]);

export const WalkCalibration = z.object({
  /** Observed ÷ profile walking speed. Clamped server-side to 0.6–1.5. */
  paceFactor: z.number().positive().max(5).default(1),
  /** Observed ÷ planned time at a cache. Clamped server-side to 0.5–2. */
  dwellFactor: z.number().positive().max(5).default(1),
});
export type WalkCalibration = z.infer<typeof WalkCalibration>;

export const WalkReplanInput = z.object({
  position: LngLat,
  accuracyM: z.number().nonnegative().optional(),
  returnPoint: LngLat,
  /** Back-at-the-return-point time. */
  deadline: z.iso.datetime({ offset: true }),
  /**
   * The client's clock when sending. Time left = deadline − now, both on the
   * client's clock, so a phone clock that's off doesn't shift the budget.
   */
  now: z.iso.datetime({ offset: true }),
  /** Snapshot of the walk's route profile (works even if it's edited later). */
  profile: RouteProfileSettings,
  calibration: WalkCalibration.prefault({}),
  visitedIds: CacheIds,
  skippedIds: CacheIds,
  dnfIds: CacheIds,
  /** "Go here next": the user's chosen next stop; always kept first. */
  lockedNextId: z.number().int().positive().optional(),
  /** The current tentative order, for the stability rule. */
  previousOrder: z.array(z.number().int().positive()).max(100).default([]),
});
export type WalkReplanInput = z.infer<typeof WalkReplanInput>;

export const WalkStop = z.object({
  cacheId: z.number().int().positive(),
  arriveAt: z.iso.datetime({ offset: true }),
  leaveAt: z.iso.datetime({ offset: true }),
});
export type WalkStop = z.infer<typeof WalkStop>;

export const WalkReplanResult = z.object({
  /** A route that is back by the deadline (minus buffer) exists. */
  feasible: z.boolean(),
  /** Whether the previous tentative route was kept (stability rule). */
  kept: z.enum(["previous", "new"]),
  reason: z.string(),
  order: z.array(WalkStop),
  /** Arrival at the return point when following `order`. */
  returnAt: z.iso.datetime({ offset: true }),
  /** Latest time to leave the last stop (or now, with no stops) and be back in time. */
  leaveLastBy: z.iso.datetime({ offset: true }),
  /** Spare minutes before deadline − buffer (negative = late). */
  slackMinutes: z.number(),
  /** Walking straight back from here, in minutes. */
  minutesToReturn: z.number().nonnegative(),
  /** Only with a locked next stop that doesn't fit: how late it makes you. */
  lateByMinutes: z.number().nonnegative().optional(),
  /** The whole tentative path, here → stops → return point. */
  geometry: GeoJsonLineString.nullable(),
  /** The leg to the next stop (or to the return point when there's none). */
  nextLeg: z
    .object({
      geometry: GeoJsonLineString,
      meters: z.number().nonnegative(),
      seconds: z.number().nonnegative(),
    })
    .nullable(),
  /** How many caches were considered. */
  candidates: z.number().int().nonnegative(),
});
export type WalkReplanResult = z.infer<typeof WalkReplanResult>;
