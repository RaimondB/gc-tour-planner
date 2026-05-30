// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";
import { CacheType, WaypointType } from "../caches/index.js";

export const ParsedAttribute = z.object({
  id: z.number().int().positive(),
  positive: z.boolean(),
});
export type ParsedAttribute = z.infer<typeof ParsedAttribute>;

export const ParsedCache = z.object({
  sourceId: z.string(),
  code: z.string(),
  type: CacheType,
  name: z.string(),
  location: LngLat,
  difficulty: z.number().min(1).max(5).nullable(),
  terrain: z.number().min(1).max(5).nullable(),
  size: z.string().nullable(),
  archived: z.boolean(),
  /**
   * Temporarily disabled by the cache owner (Groundspeak GPX:
   * `available="False"` while `archived="False"`). Distinct from
   * archived — disabled caches may come back; archived ones are
   * permanently gone. The map renders disabled with a "Z" overlay
   * (matching the geocaching.com convention) at 50 % opacity.
   */
  disabled: z.boolean(),
  attributes: z.array(ParsedAttribute),
  /**
   * FR-SF8 description-keyword hints — multilingual scan over the
   * cache's short+long description text. Each entry is a stable key
   * from `DESCRIPTION_HINTS` (e.g. `"fishingRod"`). Defaults to `[]`
   * when the parser couldn't extract description text.
   */
  descriptionHints: z.array(z.string()).default([]),
});
export type ParsedCache = z.infer<typeof ParsedCache>;

export const ParsedWaypoint = z.object({
  parentCode: z.string(),
  type: WaypointType,
  name: z.string(),
  location: LngLat,
  note: z.string().nullable(),
});
export type ParsedWaypoint = z.infer<typeof ParsedWaypoint>;

/**
 * Per-upload statistics surfaced on the upload response (FR-I11).
 * Drives the "what just happened" summary block the web dropzone
 * shows after a successful upload.
 */
export const UploadStats = z.object({
  /** Distinct cache count from the upload (sum of all `byType` values). */
  total: z.number().int().nonnegative(),
  /** Counts per cache type (Traditional / Multi / Mystery / …). Keys are CacheType strings. */
  byType: z.record(z.string(), z.number().int().nonnegative()),
  /** Caches whose `available="False"` (temporarily disabled by the owner). */
  disabled: z.number().int().nonnegative(),
  /** Caches whose `archived="True"` (permanently gone). */
  archived: z.number().int().nonnegative(),
  /** Inserted: this upload created the row. */
  new: z.number().int().nonnegative(),
  /** Updated: an existing row was overwritten with this upload's values. */
  updated: z.number().int().nonnegative(),
  /**
   * Skipped: an existing row had a newer `source_exported_at` than
   * this upload's `<gpx><time>`, so the upsert was a no-op for it
   * (FR-I10 staleness guard).
   */
  stale: z.number().int().nonnegative(),
  /** PQ generation timestamp from `<gpx><time>`; null if absent. */
  exportedAt: z.string().datetime({ offset: true }).nullable(),
});
export type UploadStats = z.infer<typeof UploadStats>;

export const ParsedGpx = z.object({
  caches: z.array(ParsedCache),
  waypoints: z.array(ParsedWaypoint),
  warnings: z.array(z.string()),
  /**
   * The `<gpx><time>` of the source file — when Groundspeak generated
   * the Pocket Query. `null` when the GPX had no top-level `<time>`
   * (rare; tolerable — staleness guard treats null as "always allow").
   * The upsert path copies this onto each cache's `source_exported_at`.
   */
  exportedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ParsedGpx = z.infer<typeof ParsedGpx>;
