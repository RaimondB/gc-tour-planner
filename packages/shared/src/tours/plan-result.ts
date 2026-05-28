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
});
export type PlanResult = z.infer<typeof PlanResult>;
