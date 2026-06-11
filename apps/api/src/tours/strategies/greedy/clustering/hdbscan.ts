// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { WalkingEdge } from "../walking-graph.js";
import type {
  ClusteringContext,
  ClusteringStrategy,
  RawCluster,
} from "./strategy.js";

/**
 * Density-aware clustering inspired by HDBSCAN's robust-single-linkage core.
 *
 * NOT full HDBSCAN: we skip the condensed-tree stability extraction in favour
 * of a simpler recursive bisection on the mutual-reachability MST. The pieces
 * we keep are the parts that matter for our problem:
 *
 *   1. Per-cache **core distance** (k-th nearest walking neighbour) — buffers
 *      isolated caches against being chained into a dense neighbour.
 *   2. **Mutual reachability** distance: mreach(a,b) = max(core(a), core(b), d(a,b))
 *      — lifts edge weights for caches whose neighbourhoods are sparse, so a
 *      single short bridge can't fuse two density-distinct regions.
 *   3. **MST + recursive cut** on the largest mreach edge while both halves
 *      still satisfy `minClusterSize` — produces a forest of stable clusters.
 *
 * The walking graph is already capped at `maxLinkMeters`, so edges that don't
 * survive the cap simply never enter the MST. Caches with too few k-NN
 * neighbours have +Infinity core distance and fall out as noise — equivalent
 * to HDBSCAN classifying them as label -1.
 */
export const hdbscanStrategy: ClusteringStrategy = {
  name: "hdbscan",

  cluster(ctx: ClusteringContext): RawCluster[] {
    if (ctx.pool.length < 2) return [];
    const minSamples = effectiveMinSamples(ctx.input.minClusterSize);
    const minClusterSize = ctx.input.minClusterSize;

    const ids = ctx.pool.map((c) => c.id);
    const coreDist = computeCoreDistances(ids, ctx.edges, minSamples);
    const mreachEdges = buildMreachEdges(ctx.edges, coreDist);

    const components = kruskalMstComponents(ids, mreachEdges);
    const out: number[][] = [];
    for (const comp of components) {
      bisectByLargestMreach(comp, minClusterSize, out);
    }
    return out
      .filter((c) => c.length >= 2)
      .map((cacheIds) => ({ cacheIds: cacheIds.sort((a, b) => a - b) }));
  },

  paramsForDiagnostics(ctx) {
    return {
      minClusterSize: ctx.input.minClusterSize,
      minSamples: effectiveMinSamples(ctx.input.minClusterSize),
      maxLinkMeters: ctx.input.maxLinkMeters,
    };
  },

  epsilonMetersForDiagnostics() {
    return 0;
  },

  // HDBSCAN's mreach already filters sparse-neighbourhood caches (they have
  // +Inf core distance and never get an MST edge). Re-running the walking
  // outlier trim would drop them a second time as a no-op, but the
  // GEOGRAPHIC trim is still useful — a dense urban pocket can still pick up
  // a far member via an early MST merge.
  skipRefinement: new Set(["walking-outlier-trim"] as const),
};

/* --- internals ---------------------------------------------------------- */

/** MST tree node — leaves carry a cache id; internal nodes carry the merge edge. */
interface MstNode {
  size: number;
  members: number[];
  /** Largest mreach edge in the subtree, with its two endpoint leaves. */
  splitEdge?: { weight: number; left: MstNode; right: MstNode };
}

export function effectiveMinSamples(minClusterSize: number): number {
  // HDBSCAN's `min_samples` ≈ smoothing of density. Lower than min_cluster_size
  // gives a noisier core-distance signal; equal yields the most aggressive
  // noise rejection. Halve it as a sensible default — same shape as our DBSCAN
  // minPts heuristic so the two strategies are roughly comparable.
  return Math.max(2, Math.floor(minClusterSize / 2));
}

export function computeCoreDistances(
  ids: readonly number[],
  edges: readonly WalkingEdge[],
  k: number,
): Map<number, number> {
  // Collect all edge weights touching each id (the walking graph is sparse
  // and already capped — anything not present means the pair is > maxLinkMeters).
  const buckets = new Map<number, number[]>();
  for (const id of ids) buckets.set(id, []);
  for (const e of edges) {
    buckets.get(e.fromCacheId)?.push(e.meters);
    buckets.get(e.toCacheId)?.push(e.meters);
  }
  const core = new Map<number, number>();
  for (const [id, dists] of buckets) {
    if (dists.length < k) {
      core.set(id, Number.POSITIVE_INFINITY);
      continue;
    }
    dists.sort((a, b) => a - b);
    core.set(id, dists[k - 1] ?? Number.POSITIVE_INFINITY);
  }
  return core;
}

export interface MreachEdge {
  from: number;
  to: number;
  /** Mutual reachability distance, = max(core[from], core[to], walking). */
  weight: number;
}

export function buildMreachEdges(
  edges: readonly WalkingEdge[],
  coreDist: ReadonlyMap<number, number>,
): MreachEdge[] {
  const out: MreachEdge[] = [];
  for (const e of edges) {
    const ca = coreDist.get(e.fromCacheId);
    const cb = coreDist.get(e.toCacheId);
    if (ca === undefined || cb === undefined) continue;
    const w = Math.max(ca, cb, e.meters);
    if (!Number.isFinite(w)) continue;
    out.push({ from: e.fromCacheId, to: e.toCacheId, weight: w });
  }
  return out;
}

/**
 * Kruskal's algorithm building a union-find of MST roots, then walking the
 * forest to produce `MstNode` trees rooted at each component. We track the
 * largest mreach edge inside each subtree so the bisection step can split on
 * it in O(log n) without re-traversing.
 */
function kruskalMstComponents(
  ids: readonly number[],
  edges: readonly MreachEdge[],
): MstNode[] {
  // Sort edges ascending — Kruskal merges in increasing weight order.
  // Tie-break on (from, to) for determinism.
  const sorted = edges.slice().sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight;
    const aMin = Math.min(a.from, a.to);
    const bMin = Math.min(b.from, b.to);
    if (aMin !== bMin) return aMin - bMin;
    return Math.max(a.from, a.to) - Math.max(b.from, b.to);
  });

  // Each node starts as a singleton leaf.
  const nodeOf = new Map<number, MstNode>();
  for (const id of ids) {
    nodeOf.set(id, { size: 1, members: [id] });
  }
  // Union-find over MstNode roots, keyed by representative cache id.
  const parent = new Map<number, number>();
  for (const id of ids) parent.set(id, id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    // Path compression.
    let cur = x;
    while (parent.get(cur)! !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };

  for (const e of sorted) {
    const ra = find(e.from);
    const rb = find(e.to);
    if (ra === rb) continue;
    const na = nodeOf.get(ra)!;
    const nb = nodeOf.get(rb)!;
    const merged: MstNode = {
      size: na.size + nb.size,
      members: na.members.concat(nb.members),
      splitEdge: { weight: e.weight, left: na, right: nb },
    };
    // Keep the larger subtree's representative as the union root for shorter
    // path-compression chains.
    if (na.size >= nb.size) {
      parent.set(rb, ra);
      nodeOf.set(ra, merged);
    } else {
      parent.set(ra, rb);
      nodeOf.set(rb, merged);
    }
  }

  const seenRoots = new Set<number>();
  const components: MstNode[] = [];
  for (const id of ids) {
    const r = find(id);
    if (seenRoots.has(r)) continue;
    seenRoots.add(r);
    components.push(nodeOf.get(r)!);
  }
  // Stable order: largest component first, then by smallest member id.
  components.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    const aMin = Math.min(...a.members);
    const bMin = Math.min(...b.members);
    return aMin - bMin;
  });
  return components;
}

/**
 * Recursively bisect an MST node by cutting its largest mreach edge whenever
 * both resulting halves still satisfy `minClusterSize`. Singletons / undersize
 * branches are dropped (HDBSCAN noise).
 */
function bisectByLargestMreach(
  node: MstNode,
  minClusterSize: number,
  out: number[][],
): void {
  if (node.size < minClusterSize) return;
  if (!node.splitEdge) {
    out.push(node.members.slice());
    return;
  }
  const { left, right } = node.splitEdge;
  if (left.size >= minClusterSize && right.size >= minClusterSize) {
    bisectByLargestMreach(left, minClusterSize, out);
    bisectByLargestMreach(right, minClusterSize, out);
    return;
  }
  // Splitting here would orphan a small branch — keep the whole subtree
  // together as a candidate cluster.
  out.push(node.members.slice());
}
