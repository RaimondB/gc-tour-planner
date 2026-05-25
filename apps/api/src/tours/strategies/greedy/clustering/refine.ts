// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches, Tours } from "@gctp/shared";
import { haversineMeters } from "../equirectangular.js";
import { splitByMstCut } from "../louvain-clusters.js";
import type { WalkingEdge } from "../walking-graph.js";
import type { ClusteringContext, RawCluster, RefinementStage } from "./strategy.js";

/**
 * Shared post-clustering refinement. Order is fixed
 * (walking-trim → geo-trim → mst-cut → jaccard-dedup) — `skip` only
 * short-circuits stages, never reorders. Keeps cross-strategy comparisons fair.
 *
 * Returns the same shape as the raw clusters: an ordered list of cache-id
 * arrays, ready for scoring. Empty clusters are dropped.
 */
export function refineClusters(
  raw: readonly RawCluster[],
  ctx: ClusteringContext,
  skip: ReadonlySet<RefinementStage> = new Set(),
): number[][] {
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const adj = buildAdjacency(ctx.edges);
  const clusterDistanceMeters = (a: number, b: number): number => {
    if (a === b) return 0;
    const ca = poolById.get(a);
    const cb = poolById.get(b);
    if (!ca || !cb) return Number.POSITIVE_INFINITY;
    return haversineMeters(
      [ca.location.coordinates[0]!, ca.location.coordinates[1]!],
      [cb.location.coordinates[0]!, cb.location.coordinates[1]!],
    );
  };

  const absoluteCapMeters = ctx.input.distanceBudgetMeters / 4;

  const keptSets: Set<number>[] = [];
  const output: number[][] = [];
  for (const cand of raw) {
    const parts = skip.has("mst-cut")
      ? [cand.cacheIds.slice()]
      : splitByMstCut(
          cand.cacheIds,
          clusterDistanceMeters,
          ctx.input.distanceBudgetMeters,
          ctx.input.minClusterSize,
          ctx.input.maxCaches,
        );

    for (const part of parts) {
      let ids: number[] = part.slice().sort((a, b) => a - b);

      if (!skip.has("walking-outlier-trim")) {
        ids = trimWalkingOutliers(ids, adj);
      }
      if (!skip.has("geographic-outlier-trim")) {
        ids = trimGeographicOutliers(
          ids,
          poolById,
          ctx.input.minClusterSize,
          absoluteCapMeters,
        );
      }
      if (ids.length < ctx.input.minClusterSize) continue;

      if (!skip.has("jaccard-dedup")) {
        const set = new Set(ids);
        const dup = keptSets.some((k) => jaccard(k, set) >= JACCARD_DEDUP_THRESHOLD);
        if (dup) continue;
        keptSets.push(set);
      } else {
        keptSets.push(new Set(ids));
      }
      output.push(ids);
    }
  }
  return output;
}

/**
 * Apply only the trim stages to a single id set (no MST-cut, no Jaccard dedup).
 * Used by `/tours/clusters/explain` to predict which caches would be dropped
 * from a user-supplied selection.
 */
export function projectTrims(
  cacheIds: readonly number[],
  ctx: ClusteringContext,
): {
  walkingOutliersDropped: number[];
  geographicOutliersDropped: number[];
  centroid: [number, number];
  medianFromCentroidM: number;
  capM: number;
} {
  const adj = buildAdjacency(ctx.edges);
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const absoluteCapMeters = ctx.input.distanceBudgetMeters / 4;
  const sorted = cacheIds.slice().sort((a, b) => a - b);

  const afterWalking = trimWalkingOutliers(sorted, adj);
  const walkingOutliersDropped = sorted.filter((id) => !afterWalking.includes(id));

  const afterGeo = trimGeographicOutliers(
    afterWalking,
    poolById,
    1, // for explain we don't enforce a min — show ALL drops the trim would make
    absoluteCapMeters,
  );
  const geographicOutliersDropped = afterWalking.filter((id) => !afterGeo.includes(id));

  // Centroid + median over the post-walking set (matches what the geo trim
  // computed on the first iteration the user can act on).
  const coords = afterWalking
    .map((id) => poolById.get(id))
    .filter((c): c is Caches.CacheDTO => c !== undefined)
    .map(
      (c) =>
        [c.location.coordinates[0]!, c.location.coordinates[1]!] as [
          number,
          number,
        ],
    );
  const centroid: [number, number] =
    coords.length === 0
      ? [0, 0]
      : [meanOf(coords.map((c) => c[0])), meanOf(coords.map((c) => c[1]))];
  const distances = coords.map((c) => haversineMeters(c, centroid));
  const sortedDistances = distances.slice().sort((a, b) => a - b);
  const median =
    sortedDistances.length === 0
      ? 0
      : (sortedDistances[Math.floor(sortedDistances.length / 2)] ?? 0);
  const capM = Math.min(median * 2, absoluteCapMeters);

  return {
    walkingOutliersDropped,
    geographicOutliersDropped,
    centroid,
    medianFromCentroidM: median,
    capM,
  };
}

/**
 * Project just the MST-cut against a single id set. Used by the explain
 * endpoint to show "this selection would be split into N sub-clusters".
 */
export function projectMstSplit(
  cacheIds: readonly number[],
  ctx: ClusteringContext,
): number[][] {
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const clusterDistanceMeters = (a: number, b: number): number => {
    if (a === b) return 0;
    const ca = poolById.get(a);
    const cb = poolById.get(b);
    if (!ca || !cb) return Number.POSITIVE_INFINITY;
    return haversineMeters(
      [ca.location.coordinates[0]!, ca.location.coordinates[1]!],
      [cb.location.coordinates[0]!, cb.location.coordinates[1]!],
    );
  };
  // Explain runs the cut with a permissive min of 2 so single splits show up
  // even for tiny user selections; production refine uses input.minClusterSize.
  return splitByMstCut(
    cacheIds,
    clusterDistanceMeters,
    ctx.input.distanceBudgetMeters,
    2,
    ctx.input.maxCaches,
  );
}

/** Jaccard threshold reused from the original Louvain pipeline (line 292). */
export const JACCARD_DEDUP_THRESHOLD = 0.8;

/* --- internal helpers --------------------------------------------------- */

function buildAdjacency(
  edges: readonly WalkingEdge[],
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const e of edges) {
    let a = adj.get(e.fromCacheId);
    if (!a) {
      a = new Set();
      adj.set(e.fromCacheId, a);
    }
    a.add(e.toCacheId);
    let b = adj.get(e.toCacheId);
    if (!b) {
      b = new Set();
      adj.set(e.toCacheId, b);
    }
    b.add(e.fromCacheId);
  }
  return adj;
}

/**
 * Drop cluster members with no walking-graph edge to any other member.
 * Iterates to a fixed point — removing one outlier can newly-isolate another
 * member whose only in-cluster neighbour was the just-dropped node.
 */
function trimWalkingOutliers(
  cacheIds: readonly number[],
  adj: ReadonlyMap<number, ReadonlySet<number>>,
): number[] {
  const set = new Set(cacheIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of set) {
      const neighbours = adj.get(id);
      if (!neighbours) {
        set.delete(id);
        changed = true;
        continue;
      }
      let hasInCluster = false;
      for (const n of neighbours) {
        if (set.has(n)) {
          hasInCluster = true;
          break;
        }
      }
      if (!hasInCluster) {
        set.delete(id);
        changed = true;
      }
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * Drop caches whose distance to the cluster centroid exceeds
 * `min(2 × median, distanceBudget / 4)`. Iterates until stable so dropping a
 * far cache can let a fringe cache newly-qualify as an outlier as the
 * centroid shifts.
 */
function trimGeographicOutliers(
  cacheIds: readonly number[],
  poolById: ReadonlyMap<number, Caches.CacheDTO>,
  minSize: number,
  absoluteCapMeters: number,
): number[] {
  let ids = cacheIds.slice();
  let changed = true;
  while (changed && ids.length >= minSize) {
    changed = false;
    const coords = ids
      .map((id) => poolById.get(id))
      .filter((c): c is Caches.CacheDTO => c !== undefined)
      .map(
        (c) =>
          [c.location.coordinates[0]!, c.location.coordinates[1]!] as [
            number,
            number,
          ],
      );
    if (coords.length === 0) break;
    const centroid: [number, number] = [
      meanOf(coords.map((c) => c[0])),
      meanOf(coords.map((c) => c[1])),
    ];
    const distances = coords.map((c) => haversineMeters(c, centroid));
    const sorted = distances.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const threshold = Math.min(median * 2, absoluteCapMeters);
    const kept: number[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (distances[i]! <= threshold) kept.push(ids[i]!);
      else changed = true;
    }
    ids = kept;
  }
  return ids;
}

function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function meanOf(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
