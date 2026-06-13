// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonPoint } from "../geo/index.js";
import { PlanResult } from "./plan-result.js";

/**
 * A point-in-time snapshot of one cache in a saved tour, baked into the
 * `plan` JSONB at save time (M6-γ). Carries only what the saved-tour view —
 * and the future public shared view (M6-δ, GET /shared/:slug) — needs to
 * render: identity, label, and where to draw the marker. Denormalising it
 * here means the shared view never reads owner-scoped cache tables (ADR-0022),
 * and a saved tour still renders after its caches are deleted or re-uploaded
 * (FR-P1.3). `type` is a plain string (not the CacheType enum) so a stored
 * snapshot keeps parsing even if the type vocabulary grows.
 */
export const TourCacheSnapshot = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  type: z.string(),
  name: z.string(),
  location: GeoJsonPoint,
});
export type TourCacheSnapshot = z.infer<typeof TourCacheSnapshot>;

/**
 * What gets persisted verbatim in `tours.plan`: the full in-memory PlanResult
 * (so the tour re-renders without re-planning — legs, dropped caches, parking
 * choice all survive) plus the denormalised cache snapshot. A cache id in
 * `PlanResult.orderedCacheIds` that no longer resolves is simply absent from
 * `caches` — the view annotates it as missing rather than breaking (FR-P1.3).
 */
export const StoredPlan = PlanResult.extend({
  caches: z.array(TourCacheSnapshot),
});
export type StoredPlan = z.infer<typeof StoredPlan>;
