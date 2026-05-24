// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { latLngToCell } from "h3-js";
import type { CoordinatedCache, WalkingEdge } from "./walking-graph.js";

/**
 * H3 resolution 8 ≈ 460 m hex edge. Tuned so a typical urban park / forest
 * loop sits within a few hex cells, and density-peak selection per cell
 * gives 20–80 seeds for a 1000-cache pool — enough seed coverage without
 * paying for Louvain on the full graph.
 */
const H3_RESOLUTION = 8;

export interface SeedSubgraph {
  /** The cache id chosen as this subgraph's seed (highest k-NN degree in its H3 cell). */
  seedId: number;
  /** All caches reachable from the seed within the walking budget threshold. */
  cacheIds: number[];
  /** Edges from `walkingGraph` whose endpoints are both in `cacheIds`. */
  edges: WalkingEdge[];
}

/**
 * Bucket caches into H3 cells; pick one seed per cell as the cache with the
 * highest degree in the walking graph (tie-break on lowest id, deterministic).
 *
 * Returns at most one seed per H3 cell. A 1000-cache Dutch-style pool (dense
 * villages + forest gaps) typically yields 30–80 seeds; pure rural pools may
 * yield fewer.
 */
export function selectSeeds(
  caches: readonly CoordinatedCache[],
  edges: readonly WalkingEdge[],
): number[] {
  if (caches.length === 0) return [];

  // Degree count for the seed tiebreaker.
  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.fromCacheId, (degree.get(e.fromCacheId) ?? 0) + 1);
    degree.set(e.toCacheId, (degree.get(e.toCacheId) ?? 0) + 1);
  }

  // Bucket caches by H3 cell.
  const buckets = new Map<string, CoordinatedCache[]>();
  for (const c of caches) {
    const cell = latLngToCell(c.lat, c.lng, H3_RESOLUTION);
    const list = buckets.get(cell);
    if (list) list.push(c);
    else buckets.set(cell, [c]);
  }

  // Pick highest-degree cache per cell; tie-break on lowest id for determinism.
  const seeds: number[] = [];
  for (const cellCaches of buckets.values()) {
    let best = cellCaches[0]!;
    let bestDegree = degree.get(best.id) ?? 0;
    for (let i = 1; i < cellCaches.length; i += 1) {
      const c = cellCaches[i]!;
      const d = degree.get(c.id) ?? 0;
      if (d > bestDegree || (d === bestDegree && c.id < best.id)) {
        best = c;
        bestDegree = d;
      }
    }
    seeds.push(best.id);
  }

  // Sort for determinism — caller may consume in order.
  seeds.sort((a, b) => a - b);
  return seeds;
}

/**
 * For each seed, return the subgraph of caches reachable on foot within
 * `budgetMeters / 2` (one-way limit; a round-trip loop multiplies by 2).
 *
 * BFS the walking graph from the seed, accumulating *path* walking distance
 * (not just edge weight). Caches more than `budgetMeters / 2` away from the
 * seed are excluded. This bounds Louvain's per-seed work to O(local) and
 * guarantees every community produced is reachable as a closed loop anchored
 * near the seed.
 */
export function extractSeedSubgraphs(
  seeds: readonly number[],
  edges: readonly WalkingEdge[],
  budgetMeters: number,
): SeedSubgraph[] {
  const halfBudget = budgetMeters / 2;
  const adj = buildAdjacency(edges);

  const subgraphs: SeedSubgraph[] = [];
  for (const seedId of seeds) {
    // Dijkstra-lite via min-pop array. N is small (≤ a few hundred per seed
    // after the bbox filter), so we don't bother with a real heap.
    const dist = new Map<number, number>([[seedId, 0]]);
    const visited = new Set<number>();

    while (visited.size < dist.size) {
      let u = -1;
      let uDist = Number.POSITIVE_INFINITY;
      for (const [node, d] of dist) {
        if (!visited.has(node) && d < uDist) {
          u = node;
          uDist = d;
        }
      }
      if (u === -1 || uDist > halfBudget) break;
      visited.add(u);
      for (const { to, meters } of adj.get(u) ?? []) {
        const alt = uDist + meters;
        if (alt > halfBudget) continue;
        const prev = dist.get(to);
        if (prev === undefined || alt < prev) dist.set(to, alt);
      }
    }

    const cacheIds = Array.from(dist.keys())
      .filter((id) => (dist.get(id) ?? Infinity) <= halfBudget)
      .sort((a, b) => a - b);
    if (cacheIds.length < 2) continue;

    const cacheSet = new Set(cacheIds);
    const subEdges = edges.filter(
      (e) => cacheSet.has(e.fromCacheId) && cacheSet.has(e.toCacheId),
    );

    subgraphs.push({ seedId, cacheIds, edges: subEdges });
  }
  return subgraphs;
}

/* --- internal -------------------------------------------------------------- */

function buildAdjacency(
  edges: readonly WalkingEdge[],
): Map<number, Array<{ to: number; meters: number }>> {
  const adj = new Map<number, Array<{ to: number; meters: number }>>();
  for (const e of edges) {
    const fwd = adj.get(e.fromCacheId);
    if (fwd) fwd.push({ to: e.toCacheId, meters: e.meters });
    else adj.set(e.fromCacheId, [{ to: e.toCacheId, meters: e.meters }]);
    const rev = adj.get(e.toCacheId);
    if (rev) rev.push({ to: e.fromCacheId, meters: e.meters });
    else adj.set(e.toCacheId, [{ to: e.fromCacheId, meters: e.meters }]);
  }
  return adj;
}
