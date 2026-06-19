// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonPoint, LngLat } from "../geo/index.js";
import { hasToolRequirement } from "./attributes.js";

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
  "Adventure Lab",
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

/**
 * Multi sub-type filter (FR-SF2). `"all"` = no narrowing; the rest map to
 * `classifyMulti(stageCount)`. Applied server-side so the cache pool the
 * planner clusters matches the set shown on the map.
 */
export const MultiSubtypeFilter = z.enum([
  "all",
  "field-puzzle",
  "mini",
  "full",
]);
export type MultiSubtypeFilter = z.infer<typeof MultiSubtypeFilter>;

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
  /**
   * True when `location` holds a user-supplied solved/corrected coordinate
   * (Mystery puzzle solution or Multi final), set via a `solvedCoordinates`
   * GPX upload. The map badges these; the "only solved mysteries" filter
   * keys off it. Defaulted for back-compat with pre-feature responses.
   */
  solved: z.boolean().default(false),
  /**
   * The original posted coordinate (Groundspeak's listing coords), kept when
   * `solved` so the popup can show posted-vs-solved and offer "remove solved
   * coordinates". NULL when the cache was first seen via a solved upload (no
   * posted coord known yet) or when not solved. `location` is always the
   * effective coordinate the planner uses.
   */
  postedLocation: GeoJsonPoint.nullable().default(null),
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
  /**
   * Adventure Lab deep-link GUID — the path segment of
   * `labs.geocaching.com/goto/<id>`. Set only for `type==='Adventure Lab'`
   * stages; lets the popup link out to the Adventure (a stage has no per-stage
   * geocaching.com page). `null` for every other cache. Defaulted for back-compat.
   */
  adventureId: z.string().nullable().default(null),
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
  /**
   * When true, exclude Mystery-type caches that have no solved coordinate
   * (`solved=false`). Other cache types are unaffected. SQL:
   * `NOT (type='Mystery' AND solved=false)`. The filter sidebar's "Only
   * solved mysteries" toggle flips this.
   */
  solvedMysteriesOnly: z.boolean().optional(),
  /**
   * Multi sub-type filter (FR-SF2). `"all"`/undefined = no narrowing; a
   * concrete value keeps only Multis whose `classifyMulti(stageCount)` matches
   * (other types pass through). Server-side so the planner pool == the map.
   */
  multiSubtype: MultiSubtypeFilter.optional(),
  /**
   * Hide caches that require special equipment (FR-SF6) —
   * `hasToolRequirement(attributeIds, descriptionHints)`. Server-side so the
   * planner pool == the map.
   */
  hideToolCaches: z.boolean().optional(),
});
export type CachesQuery = z.infer<typeof CachesQuery>;

export const ClustersHint = z.array(
  z.object({
    gridCell: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type ClustersHint = z.infer<typeof ClustersHint>;

/**
 * Full server-side response. `CachesService.list` returns this so internal
 * callers (the tour planner: clustering, walking-graph, greedy planner) keep
 * every `CacheDTO` field. The HTTP `GET /caches` endpoint maps it down to the
 * lean `CachesSummaryResponse` for the wire — see [api-surface.md].
 */
export const CachesResponse = z.object({
  caches: z.array(CacheDTO),
  clustersHint: ClustersHint,
});
export type CachesResponse = z.infer<typeof CachesResponse>;

/**
 * Lean per-cache shape sent over the wire for the map. Drops the popup-only
 * and unused fields (difficulty, terrain, size, source, sourceId, archived,
 * attributeIds, descriptionHints) — those are fetched lazily per cache via
 * `GET /caches/:id` when a popup opens. A wide `/caches` query is thousands of
 * caches, so this cuts both transfer (post-gzip) and client parse/render cost.
 *
 * `name` is kept (GPX export labels + selection lists need it). `requiresTool`
 * is server-computed from the attribute ids + description hints so the
 * "hide tool caches" filter and the tour-stop tool badge stay client-side and
 * instant without shipping those arrays.
 */
export const CacheSummaryDTO = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  type: CacheType,
  name: z.string(),
  location: GeoJsonPoint,
  disabled: z.boolean(),
  /**
   * True when `location` is a user-supplied solved/corrected coordinate. The
   * map badges these (mirroring the disabled "Z" overlay) and the "only solved
   * mysteries" filter keys off it. Defaulted for back-compat.
   */
  solved: z.boolean().default(false),
  foundByMe: z.boolean(),
  stageCount: z.number().int().nonnegative().default(0),
  parkingPoints: z.array(LngLat),
  /** = hasToolRequirement(attributeIds, descriptionHints), computed server-side. */
  requiresTool: z.boolean(),
  /**
   * Adventure Lab deep-link GUID (Adventure Lab stages only; `null` otherwise).
   * Kept on the lean wire shape so the map popup can render the "open in
   * Adventure Lab" link immediately, without the per-cache detail round-trip.
   */
  adventureId: z.string().nullable().default(null),
});
export type CacheSummaryDTO = z.infer<typeof CacheSummaryDTO>;

export const CachesSummaryResponse = z.object({
  caches: z.array(CacheSummaryDTO),
  clustersHint: ClustersHint,
});
export type CachesSummaryResponse = z.infer<typeof CachesSummaryResponse>;

/** Project a full `CacheDTO` to the lean wire shape (computes `requiresTool`). */
export function toCacheSummary(c: CacheDTO): CacheSummaryDTO {
  return {
    id: c.id,
    code: c.code,
    type: c.type,
    name: c.name,
    location: c.location,
    disabled: c.disabled,
    solved: c.solved,
    foundByMe: c.foundByMe,
    stageCount: c.stageCount,
    parkingPoints: c.parkingPoints,
    requiresTool: hasToolRequirement(c.attributeIds, c.descriptionHints),
    adventureId: c.adventureId,
  };
}
