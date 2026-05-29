// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, GeoJsonPoint } from "../geo/index.js";

export const ParkingChoice = z.object({
  type: z.enum(["pq", "osrm-nearest", "user", "osm"]),
  point: GeoJsonPoint,
  reason: z.string(),
  /**
   * When `type === "osm"`, identifies the source feature in
   * `parking_facilities`. Lets the UI link the picked parking back to its
   * map polygon and surface attributes (fee, access, capacity).
   */
  osm: z
    .object({
      osmId: z.number().int(),
      // osm2pgsql flex stores uppercase: N (node), W (way), R (relation).
      osmType: z.enum(["N", "W", "R"]),
      access: z.string().nullable(),
      fee: z.string().nullable(),
      name: z.string().nullable(),
    })
    .optional(),
});
export type ParkingChoice = z.infer<typeof ParkingChoice>;

export const PlanTotals = z.object({
  meters: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  visitMinutes: z.number().nonnegative(),
});
export type PlanTotals = z.infer<typeof PlanTotals>;

/**
 * One OSRM route candidate considered by the loop-aware leg picker for a
 * single leg of the tour. The picker requests `1 + PLANNER_LOOP_ALT_COUNT`
 * (default 3) candidates per leg via `osrm.routeAlternatives`; before this
 * type existed the unpicked ones were discarded.
 *
 * Surfaced now so the UI can offer a "manual leg swap" affordance — click
 * a leg, see the alternatives the picker scored, pick a different one.
 * Each candidate carries enough state to render itself + to be picked
 * in place of the picker's selection without another OSRM round trip.
 */
export const PlanLegAlternative = z.object({
  meters: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  geometry: GeoJsonLineString,
});
export type PlanLegAlternative = z.infer<typeof PlanLegAlternative>;

/**
 * One leg of the planned closed loop, exposed for the manual edit-mode
 * UI. Legs are ordered: index 0 is parking→firstCache, indices
 * 1..(n-2) are cache→cache, index n-1 is lastCache→parking. The
 * parking endpoints use the sentinel `fromCacheId = 0` / `toCacheId = 0`
 * so the schema stays uniform.
 *
 * `alternatives` always includes the picked leg at
 * `selectedAlternativeIndex`. When no extras existed (OSRM only returned
 * the primary) the array has length 1 — the UI then shows "no
 * alternatives" for that leg.
 */
export const PlanLeg = z.object({
  index: z.number().int().nonnegative(),
  /** 0 = parking endpoint, otherwise a cache id from `orderedCacheIds`. */
  fromCacheId: z.number().int().nonnegative(),
  toCacheId: z.number().int().nonnegative(),
  meters: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  geometry: GeoJsonLineString,
  alternatives: z.array(PlanLegAlternative).min(1),
  selectedAlternativeIndex: z.number().int().nonnegative(),
});
export type PlanLeg = z.infer<typeof PlanLeg>;

export const PlanResult = z.object({
  orderedCacheIds: z.array(z.number().int().positive()),
  /**
   * Cache ids the planner dropped from the input cluster because each one
   * added more walking distance to the tour than it was worth (see the
   * marginal-cost trim in apps/api/src/tours/strategies/greedy/marginal-trim.ts).
   * Empty when no cache was trimmed. Surfaced so the UI can show "skipped
   * for tour quality" alongside the routed loop, rather than silently
   * shrinking the cluster.
   */
  droppedCacheIds: z.array(z.number().int().positive()).default([]),
  polyline: GeoJsonLineString,
  totals: PlanTotals,
  parking: ParkingChoice,
  scoreBreakdown: z.record(z.string(), z.number()),
  /**
   * Per-leg breakdown with the alternatives OSRM offered for each pair.
   * Default `[]` for back-compat with strategies that don't populate it
   * (e.g. the solver path, which delegates Pass 2 to a sidecar that
   * doesn't surface alternatives). The aggregated `polyline` above is
   * still the source of truth for non-edit-mode rendering.
   */
  legs: z.array(PlanLeg).default([]),
});
export type PlanResult = z.infer<typeof PlanResult>;
