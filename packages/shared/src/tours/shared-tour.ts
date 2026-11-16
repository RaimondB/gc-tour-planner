// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, GeoJsonPoint } from "../geo/index.js";
import { PlanTotals } from "./plan-result.js";
import { TourCacheSnapshot } from "./stored-plan.js";

/**
 * Response from `POST /tours/:id/share` (FR-P3.1). The opaque slug plus the
 * client-resolvable path; the client builds the absolute URL from its own
 * origin so the API never has to know its public hostname.
 */
export const ShareResponse = z.object({
  slug: z.string(),
  /** Client-relative path for the share, e.g. `/shared/<slug>`. */
  path: z.string(),
});
export type ShareResponse = z.infer<typeof ShareResponse>;

/**
 * The **public**, anonymous payload served by `GET /shared/:slug` (FR-P3.2,
 * ADR-0022). Assembled solely from the tour's denormalised snapshot — geometry,
 * totals, parking point, and the cache list. It deliberately carries **none** of:
 * the score breakdown / soft-preference internals, the owner id/email/display
 * name, the per-leg breakdown, the dropped caches, or any of the user's other
 * tours. A shared link is "here is a walk", not "here is how I tuned it".
 */
export const SharedTour = z.object({
  name: z.string(),
  /** Distance + time totals only (no score breakdown). */
  totals: PlanTotals,
  /** Routed closed-loop polyline. */
  polyline: GeoJsonLineString,
  /** Chosen parking/start point; null when the planner fell back to a centroid. */
  parking: GeoJsonPoint.nullable(),
  /** Ordered cache snapshot — id/code/type/name/location, as of save time. */
  caches: z.array(TourCacheSnapshot),
});
export type SharedTour = z.infer<typeof SharedTour>;
