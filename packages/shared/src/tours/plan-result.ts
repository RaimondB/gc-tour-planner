// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, GeoJsonPoint } from "../geo/index.js";

export const ParkingChoice = z.object({
  type: z.enum(["pq", "osrm-nearest", "user"]),
  point: GeoJsonPoint,
  reason: z.string(),
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
  polyline: GeoJsonLineString,
  totals: PlanTotals,
  parking: ParkingChoice,
  scoreBreakdown: z.record(z.string(), z.number()),
});
export type PlanResult = z.infer<typeof PlanResult>;
