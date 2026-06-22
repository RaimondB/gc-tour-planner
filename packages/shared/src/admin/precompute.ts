// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";

/**
 * Per-cache precompute kinds tracked in `cache_precompute_state`. Landuse
 * was removed in ADR-0009: landuse polygons are now imported region-wide
 * via osm2pgsql, not per-cache, so freshness is one timestamp on
 * `landuse_import_meta` rather than N×CacheCount rows here. See
 * `/admin/landuse/status` for the new landuse health endpoint.
 *
 * The Postgres `precompute_kind` enum still has 'landuse' for back-compat
 * with old rows that the migration deletes — we just don't write new ones.
 */
export const PrecomputeKind = z.enum(["walking"]);
export type PrecomputeKind = z.infer<typeof PrecomputeKind>;

/** Wire-format mirror of the Postgres `precompute_state` enum. */
export const PrecomputeState = z.enum([
  "pending",
  "in_progress",
  "fresh",
  "failed",
]);
export type PrecomputeState = z.infer<typeof PrecomputeState>;

/**
 * Per-kind freshness counts for the admin dashboard.
 *
 * `missing` covers caches that have no `cache_precompute_state` row yet
 * for this kind — these are "never precomputed" and must be retriggered
 * separately from `failed` rows.
 */
export const PrecomputeKindCounts = z.object({
  fresh: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});
export type PrecomputeKindCounts = z.infer<typeof PrecomputeKindCounts>;

export const PrecomputeSummary = z.object({
  walking: PrecomputeKindCounts,
  /**
   * The OSRM extract version the summary was computed against. Surfaced so
   * operators can tell at a glance whether a stale-count spike was caused
   * by an OSRM extract bump (all walking rows mismatch the new version)
   * vs. genuine drift.
   */
  osrmVersion: z.string(),
});
export type PrecomputeSummary = z.infer<typeof PrecomputeSummary>;

export const StaleCacheEntry = z.object({
  cacheId: z.number().int().positive(),
  kind: PrecomputeKind,
  state: PrecomputeState.nullable(),
  /** ISO 8601 timestamp string, or null if never run. */
  fetchedAt: z.string().nullable(),
  osrmVersion: z.string().nullable(),
  errorText: z.string().nullable(),
});
export type StaleCacheEntry = z.infer<typeof StaleCacheEntry>;

export const StaleCacheListResponse = z.object({
  entries: z.array(StaleCacheEntry),
  /** Total stale cache count for this kind across the whole DB. */
  total: z.number().int().nonnegative(),
});
export type StaleCacheListResponse = z.infer<typeof StaleCacheListResponse>;

export const RetriggerStaleRequest = z.object({
  /**
   * Currently 'walking' is the only per-cache precompute kind (ADR-0009
   * moved landuse off per-cache tracking). 'all' is kept for forward
   * compatibility but is currently equivalent to 'walking'.
   */
  kind: z.enum(["walking", "all"]),
});
export type RetriggerStaleRequest = z.infer<typeof RetriggerStaleRequest>;

export const RetriggerStaleResponse = z.object({
  enqueued: z.number().int().nonnegative(),
  jobIds: z.array(z.string()),
});
export type RetriggerStaleResponse = z.infer<typeof RetriggerStaleResponse>;

export const RetriggerOneRequest = z.object({
  cacheId: z.number().int().positive(),
  kind: PrecomputeKind,
});
export type RetriggerOneRequest = z.infer<typeof RetriggerOneRequest>;

/**
 * Walking-precompute health for Adventure Lab stages only (FR-I20). `counts`
 * buckets every AL stage by walking-precompute state (so `missing` = stages with
 * no `route_legs` yet, isolated in the walking graph); `total` is the AL stage
 * count. Backed by `GET /admin/precompute/adventure-labs`.
 */
export const AdventureLabWalkingStatus = z.object({
  counts: PrecomputeKindCounts,
  total: z.number().int().nonnegative(),
  osrmVersion: z.string(),
});
export type AdventureLabWalkingStatus = z.infer<
  typeof AdventureLabWalkingStatus
>;
