// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonPoint, LngLat } from "../geo/index.js";

export * from "./attributes.js";
export * from "./description-hints.js";

export const CACHE_TYPES = [
  "Traditional",
  "Multi",
  "Mystery",
  "Letterbox",
  "EarthCache",
  "Event",
  "Virtual",
  "Webcam",
  "Wherigo",
  "CITO",
  "Other",
] as const;
export const CacheType = z.enum(CACHE_TYPES);
export type CacheType = z.infer<typeof CacheType>;

export const WAYPOINT_TYPES = [
  "parking",
  "reference",
  "stages",
  "trailhead",
  "final",
  "question",
] as const;
export const WaypointType = z.enum(WAYPOINT_TYPES);
export type WaypointType = z.infer<typeof WaypointType>;

export const AttributeFilter = z.object({
  id: z.number().int().positive(),
  positive: z.boolean(),
});
export type AttributeFilter = z.infer<typeof AttributeFilter>;

/**
 * AND-of-OR groups.
 *   [[A, B], [C]] means (A OR B) AND C.
 * Empty outer array means "no attribute filter".
 */
export const AttributeFilterGroups = z.array(z.array(AttributeFilter));
export type AttributeFilterGroups = z.infer<typeof AttributeFilterGroups>;

export const CacheDTO = z.object({
  id: z.number().int().positive(),
  source: z.string(),
  sourceId: z.string(),
  code: z.string(),
  type: CacheType,
  name: z.string(),
  location: GeoJsonPoint,
  difficulty: z.number().min(1).max(5).nullable(),
  terrain: z.number().min(1).max(5).nullable(),
  size: z.string().nullable(),
  archived: z.boolean(),
  /**
   * Temporarily disabled by the cache owner (FR-I10). Distinct from
   * archived. The map renders disabled markers at 50 % opacity with a
   * "Z" overlay; archived caches are excluded by default.
   */
  disabled: z.boolean(),
  attributeIds: z.array(z.number().int()),
  parkingPoints: z.array(LngLat),
  /** True if the current user has logged a find for this cache. */
  foundByMe: z.boolean(),
  /**
   * Number of `type='stages'` additional waypoints (FR-SF1). 0 for
   * non-multis; ≤ MULTI_MINI_MAX_STAGES qualifies a Multi cache as a
   * "mini-multi" in the filter sidebar. Defaulted for back-compat
   * with pre-PR3 server responses.
   */
  stageCount: z.number().int().nonnegative().default(0),
  /**
   * Multilingual tool-keyword hint keys (FR-SF8) — populated by the
   * parser via `scanDescriptionHints` over the cache's short+long
   * description text. Empty array when the description had no
   * matches or wasn't scanned. Each entry is a stable key from
   * `DESCRIPTION_HINTS` (e.g. `"fishingRod"`, `"binoculars"`).
   */
  descriptionHints: z.array(z.string()).default([]),
});
export type CacheDTO = z.infer<typeof CacheDTO>;

export const CachesQuery = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
  types: z.array(CacheType).optional(),
  attributes: AttributeFilterGroups.optional(),
  contexts: z.array(z.string()).optional(),
  /** When true, omit caches the current user has logged as found. */
  excludeFound: z.boolean().optional(),
  /**
   * When true, include caches the owner has temporarily disabled (FR-I10).
   * Default false — the filter sidebar's "Show disabled" chip flips this.
   */
  includeDisabled: z.boolean().optional(),
  /**
   * When true, include archived caches. Default false. No UI surfaces
   * this today; reserved for future debug toggle.
   */
  includeArchived: z.boolean().optional(),
});
export type CachesQuery = z.infer<typeof CachesQuery>;

export const ClustersHint = z.array(
  z.object({
    gridCell: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type ClustersHint = z.infer<typeof ClustersHint>;

export const CachesResponse = z.object({
  caches: z.array(CacheDTO),
  clustersHint: ClustersHint,
});
export type CachesResponse = z.infer<typeof CachesResponse>;
