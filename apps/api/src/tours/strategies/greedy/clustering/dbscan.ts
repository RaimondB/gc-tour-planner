// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { dbscanFromDistances } from "../dbscan.js";
import { haversineMeters } from "../equirectangular.js";
import type { WalkingEdge } from "../walking-graph.js";
import type { ClusteringContext, ClusteringStrategy, RawCluster } from "./strategy.js";

/**
 * Classical DBSCAN using walking distance where the graph has an edge, falling
 * back to haversine otherwise. ε = `maxLinkMeters`. minPts is derived from
 * `minClusterSize` so the two knobs the user already exposes drive both
 * strategies consistently.
 */
export const dbscanStrategy: ClusteringStrategy = {
  name: "dbscan",

  cluster(ctx: ClusteringContext): RawCluster[] {
    if (ctx.pool.length < 2) return [];
    const epsilon = ctx.input.maxLinkMeters;
    const minPts = effectiveMinPts(ctx.input.minClusterSize);
    const distance = buildDistanceFn(ctx.pool, ctx.edges);

    const { clusters } = dbscanFromDistances(
      ctx.pool.length,
      distance,
      epsilon,
      minPts,
    );
    // dbscanFromDistances returns indices into `pool` — convert to cache ids.
    return clusters
      .filter((c) => c.length >= 2)
      .map((indices) => ({
        cacheIds: indices.map((i) => ctx.pool[i]!.id).sort((a, b) => a - b),
      }));
  },

  paramsForDiagnostics(ctx) {
    return {
      epsilonMeters: ctx.input.maxLinkMeters,
      minPts: effectiveMinPts(ctx.input.minClusterSize),
    };
  },

  epsilonMetersForDiagnostics(ctx) {
    return ctx.input.maxLinkMeters;
  },
};

function effectiveMinPts(minClusterSize: number): number {
  // DBSCAN's minPts has a different meaning from "smallest acceptable
  // cluster" — it controls density-reachability. The shared refinement layer
  // still enforces minClusterSize, so we keep DBSCAN's minPts loose enough to
  // pick up structure, then let refinement drop too-small clusters.
  return Math.max(3, Math.floor(minClusterSize / 2));
}

function buildDistanceFn(
  pool: ReadonlyArray<{ id: number; location: { coordinates: number[] } }>,
  edges: readonly WalkingEdge[],
): (i: number, j: number) => number {
  // Edge lookup by id pair (symmetric).
  const byPair = new Map<string, number>();
  for (const e of edges) {
    const k = pairKey(e.fromCacheId, e.toCacheId);
    byPair.set(k, e.meters);
  }
  const ids = pool.map((c) => c.id);
  const coords = pool.map(
    (c) => [c.location.coordinates[0]!, c.location.coordinates[1]!] as [number, number],
  );
  return (i: number, j: number): number => {
    if (i === j) return 0;
    const a = ids[i]!;
    const b = ids[j]!;
    const walking = byPair.get(pairKey(a, b));
    if (walking !== undefined) return walking;
    // Pair not in the sparse walking graph (either >maxLinkMeters away or not
    // a k-NN). Fall back to haversine — DBSCAN's ε check will reject anything
    // beyond it anyway, so reachability stays bounded by maxLinkMeters.
    return haversineMeters(coords[i]!, coords[j]!);
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
