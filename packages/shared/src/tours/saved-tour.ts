// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonPoint } from "../geo/index.js";
import { StoredPlan } from "./stored-plan.js";

/**
 * Lean per-tour row for `GET /tours` (FR-P2.1) — enough to render the My Tours
 * list without shipping the full plan. Sorted `created_at desc` by the server.
 */
export const SavedTourSummary = z.object({
  // z.guid() (loose), not z.uuid(): consistent with the rest of the codebase
  // — zod 4's z.uuid() is RFC-strict; z.guid() matches zod 3's old
  // z.string().uuid() semantics. gen_random_uuid() values pass either way.
  id: z.guid(),
  name: z.string(),
  totalMeters: z.number().nonnegative(),
  totalSeconds: z.number().nonnegative(),
  cacheCount: z.number().int().nonnegative(),
  /** True once a share link has been minted (M6-δ). Always false in M6-γ. */
  isShared: z.boolean(),
  /**
   * True once a map snapshot has been captured (FR-W4). The image itself is
   * served as binary from `GET /tours/:id/preview`; this flag tells the client
   * whether to render the thumbnail / offline basemap or to backfill it.
   */
  hasPreview: z.boolean(),
  /**
   * The tour's start anchor (`start_point` column) — lets the My Tours list show
   * "X km away" and sort by proximity from the user's current location, computed
   * client-side (the position never leaves the device). Mirrors the same field on
   * the detail.
   */
  startPoint: GeoJsonPoint,
  createdAt: z.string(),
});
export type SavedTourSummary = z.infer<typeof SavedTourSummary>;

/**
 * Full detail for `POST /tours` (the just-saved tour) and `GET /tours/:id`
 * (FR-P2.2). Carries the StoredPlan so the client re-renders the loop without
 * re-planning. `startPoint` is inherited from the summary; `parkingPoint` and the
 * full `plan` (geometry/totals/legs) are detail-only.
 */
export const SavedTourDetail = SavedTourSummary.extend({
  parkingPoint: GeoJsonPoint.nullable(),
  plan: StoredPlan,
});
export type SavedTourDetail = z.infer<typeof SavedTourDetail>;
