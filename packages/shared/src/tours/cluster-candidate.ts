// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonPoint } from "../geo/index.js";
import { ClusteringStrategyName } from "./plan-input.js";

/**
 * One candidate cluster returned by Pass 1 of the planner. Caller picks one
 * (or auto-picks the top-scoring) and passes its `cacheIds` to `/tours/plan`
 * for Pass 2 (loop assembly).
 *
 * `score` is the linear combination of all `scoreBreakdown` contributions —
 * higher is better. The breakdown is kept on the wire so the UI can explain
 * "this cluster scored higher because its density is better".
 */
export const ClusterCandidate = z.object({
  clusterId: z.string(),
  cacheIds: z.array(z.number().int().positive()).min(2),
  centroid: GeoJsonPoint,
  /** Closed-loop lower bound via MST × 2 in meters; useful for budget hints. */
  mstLengthMeters: z.number().nonnegative(),
  score: z.number(),
  scoreBreakdown: z.record(z.string(), z.number()),
});
export type ClusterCandidate = z.infer<typeof ClusterCandidate>;

/**
 * One connected component DBSCAN found, before any size/budget trimming.
 * Returned in `diagnostics` so the UI can show "we had components of sizes
 * 14, 6, 5, 3, 3, 2, …; only the 14 met your minClusterSize floor".
 */
export const ClusterComponent = z.object({
  cacheIds: z.array(z.number().int().positive()),
  mstLengthMeters: z.number().nonnegative(),
  /** True if this component made it through the size+budget trim and is in `candidates`. */
  accepted: z.boolean(),
});
export type ClusterComponent = z.infer<typeof ClusterComponent>;

export const CacheConnectivity = z.object({
  cacheId: z.number().int().positive(),
  /**
   * Walking distance (m) to the nearest walkable cache in the candidate pool.
   * `null` means OSRM returned no walking route from this cache to any
   * other — typically because the cache lies outside the loaded OSRM
   * extract (e.g. across a country border the extract doesn't cover).
   */
  nearestWalkableMeters: z.number().nonnegative().nullable(),
});
export type CacheConnectivity = z.infer<typeof CacheConnectivity>;

export const ClusterDiagnostics = z.object({
  /**
   * ε used by DBSCAN this run — populated only by the `dbscan` strategy.
   * Other strategies leave this 0 (their meaningful knobs land in
   * `strategyParams`).
   */
  epsilonMeters: z.number().nonnegative(),
  /** Caches considered (pool size); ≤ MAX_DISCOVERY_POOL. */
  poolSize: z.number().int().nonnegative(),
  /**
   * Pre-trim components: legacy DBSCAN connected components or, under the
   * Louvain pipeline, one entry per seed subgraph (so the user can see how
   * the H3-seeded neighbourhoods sliced their pool).
   */
  components: z.array(ClusterComponent),
  cacheConnectivity: z.array(CacheConnectivity),
  /** Number of H3-density seeds chosen (Louvain pipeline only). */
  seedCount: z.number().int().nonnegative().optional(),
  /** Edges in the sparse walking graph (Louvain pipeline only). */
  edgeCount: z.number().int().nonnegative().optional(),
  /** Fraction of pool caches that hit at least one landuse polygon (0..1). */
  landuseCoverageFraction: z.number().min(0).max(1).optional(),
  /** Resolution values the Louvain sweep used. */
  resolutionsUsed: z.array(z.number()).optional(),
  /**
   * Clustering strategy that produced this result. Always populated so the UI
   * and offline-analysis scripts can compare runs across strategies.
   */
  strategyUsed: ClusteringStrategyName,
  /**
   * Strategy-specific knobs the run was executed with (σ, ε, minPts, …).
   * Echoed back verbatim so a JSON dump fully describes the configuration
   * without consulting environment defaults.
   */
  strategyParams: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type ClusterDiagnostics = z.infer<typeof ClusterDiagnostics>;

export const ClusterCandidatesResponse = z.object({
  candidates: z.array(ClusterCandidate),
  diagnostics: ClusterDiagnostics,
});
export type ClusterCandidatesResponse = z.infer<
  typeof ClusterCandidatesResponse
>;
