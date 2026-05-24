// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonPoint, LngLat } from "../geo/index.js";

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
  attributeIds: z.array(z.number().int()),
  parkingPoints: z.array(LngLat),
});
export type CacheDTO = z.infer<typeof CacheDTO>;

export const CachesQuery = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
  types: z.array(CacheType).optional(),
  attributes: AttributeFilterGroups.optional(),
  contexts: z.array(z.string()).optional(),
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
