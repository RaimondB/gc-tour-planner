// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Logger } from "@nestjs/common";
import { UndirectedGraph } from "graphology";
import louvainModule from "graphology-communities-louvain";

// `graphology-communities-louvain` is a CJS package whose default export is
// callable AND has `.assign()` / `.detailed()` methods. TS's ESM interop
// surfaces it as a module namespace, not a callable — cast it back to the
// runtime shape the d.ts actually advertises.
const louvain = louvainModule as unknown as (
  g: UndirectedGraph,
  options: { resolution: number; rng: () => number },
) => Record<string, number>;
import { leidenCommunities } from "./clustering/leiden-detect.js";
import type { SeedSubgraph } from "./seeds.js";
import type { WalkingEdge } from "./walking-graph.js";

/**
 * Resolutions to sweep. Lower γ → fewer, larger communities; higher γ →
 * more, smaller ones. We take the union across resolutions as candidates
 * and dedup by Jaccard, so the user sees both "the big loop" and "the
 * tight pocket inside it" when both are reasonable.
 */
const RESOLUTION_SWEEP = [0.4, 0.7, 1.0, 1.4] as const;

/** Two candidates are considered duplicates if their Jaccard ≥ this threshold. */
const JACCARD_DEDUP_THRESHOLD = 0.8;

/**
 * Fixed RNG seed for deterministic Louvain runs. Same subgraph in →
 * same communities out. Override via `LOUVAIN_SEED` env if you ever need
 * to compare alternate seeds for sensitivity analysis.
 */
const LOUVAIN_SEED = Number.parseInt(process.env.LOUVAIN_SEED ?? "42", 10);

export interface ClusterCandidate {
  cacheIds: number[];
  /** Which seed produced this community (for diagnostics). */
  seedId: number;
  /** Resolution that produced it; smaller γ = larger community. */
  resolution: number;
  /** Edge weight sum within the community (proxy for cohesion). */
  internalWeight: number;
}

/**
 * Run the community-detection sweep on every seed subgraph, dedup the resulting
 * communities by Jaccard, and return a flat list of candidate clusters. The
 * orchestrator scores + sorts + applies the MST-cut safety net.
 *
 * `algorithm` selects the detector — `louvain` (default) or `leiden` (Leiden's
 * refinement guarantees connected communities). Both run on the same weighted
 * graph, resolution sweep, seed, and dedup, so they're directly comparable.
 */
export function discoverClustersInSubgraphs(
  subgraphs: readonly SeedSubgraph[],
  options: {
    /** σ in `w(i,j) = exp(-d_ij / σ)`. Use `distanceBudgetMeters / 4`. */
    sigmaMeters: number;
    algorithm?: "louvain" | "leiden";
  },
): ClusterCandidate[] {
  const logger = new Logger(discoverClustersInSubgraphs.name);
  const all: ClusterCandidate[] = [];
  const algorithm = options.algorithm ?? "louvain";
  const detect = algorithm === "leiden" ? leidenCommunities : louvain;

  for (const sub of subgraphs) {
    if (sub.cacheIds.length < 2 || sub.edges.length === 0) continue;
    const g = buildWeightedGraph(sub.cacheIds, sub.edges, options.sigmaMeters);

    for (const resolution of RESOLUTION_SWEEP) {
      const rng = mulberry32(LOUVAIN_SEED ^ Math.floor(resolution * 1000));
      const mapping = detect(g, { resolution, rng });

      // Bucket nodes into communities by their assigned community id.
      const communities = new Map<number, number[]>();
      for (const [node, communityIdRaw] of Object.entries(mapping)) {
        const id = Number(node);
        const communityId = Number(communityIdRaw);
        const list = communities.get(communityId);
        if (list) list.push(id);
        else communities.set(communityId, [id]);
      }

      for (const ids of communities.values()) {
        if (ids.length < 2) continue;
        ids.sort((a, b) => a - b);
        all.push({
          cacheIds: ids,
          seedId: sub.seedId,
          resolution,
          internalWeight: internalEdgeWeightSum(
            ids,
            sub.edges,
            options.sigmaMeters,
          ),
        });
      }
    }
  }

  // Sort for deterministic dedup order: largest first, then by min id.
  all.sort((a, b) => {
    if (b.cacheIds.length !== a.cacheIds.length)
      return b.cacheIds.length - a.cacheIds.length;
    return a.cacheIds[0]! - b.cacheIds[0]!;
  });

  const deduped: ClusterCandidate[] = [];
  for (const cand of all) {
    const candSet = new Set(cand.cacheIds);
    let dropped = false;
    for (const keeper of deduped) {
      if (jaccard(candSet, keeper.cacheIds) >= JACCARD_DEDUP_THRESHOLD) {
        dropped = true;
        break;
      }
    }
    if (!dropped) deduped.push(cand);
  }

  logger.debug(
    `${algorithm}: ${subgraphs.length} subgraphs × ${RESOLUTION_SWEEP.length} resolutions → ${all.length} raw → ${deduped.length} after Jaccard dedup`,
  );
  return deduped;
}

/**
 * Safety net: if a community still exceeds the user's **distance budget**
 * (`MST × 2 > budget`), recursively cut the longest MST edge until each
 * sub-cluster fits the budget. Returns the resulting sub-clusters. A cluster
 * that already fits the budget is returned unchanged.
 *
 * Splitting is driven purely by distance, NOT by cache count: the more caches
 * that fit inside the budget, the richer the loop, so we never break up a
 * within-budget cluster just because it has many caches. (Pass-2 applies its
 * own `MAX_LOOP_CACHES` safety cap when it actually builds the tour.)
 *
 * Reused from the old greedy planner — community-detected clusters are
 * already shaped by modularity, so this safety net rarely fires in practice.
 */
export function splitByMstCut(
  members: readonly number[],
  walkingDist: (a: number, b: number) => number,
  budgetMeters: number,
  minSize: number,
  depth = 0,
): number[][] {
  if (members.length < minSize) return [];

  const localDist = (i: number, j: number): number =>
    walkingDist(members[i]!, members[j]!);
  const { edges } = buildMstEdges(members.length, localDist);
  const mst = edges.reduce((s, e) => s + e.weight, 0);

  const fitsBudget = mst * 2 <= budgetMeters;
  if (fitsBudget) return [members.slice()];

  if (depth >= 64 || edges.length === 0) return [];

  let cutIdx = 0;
  for (let i = 1; i < edges.length; i += 1) {
    const a = edges[cutIdx]!;
    const b = edges[i]!;
    if (b.weight > a.weight) {
      cutIdx = i;
      continue;
    }
    if (
      b.weight === a.weight &&
      (b.from < a.from || (b.from === a.from && b.to < a.to))
    ) {
      cutIdx = i;
    }
  }
  const cut = edges[cutIdx]!;

  // BFS the remaining MST from cut.from to split into two halves.
  const adj = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i += 1) {
    if (i === cutIdx) continue;
    const e = edges[i]!;
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const leftSide = new Set<number>();
  const queue = [cut.from];
  leftSide.add(cut.from);
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (!leftSide.has(v)) {
        leftSide.add(v);
        queue.push(v);
      }
    }
  }

  const leftMembers: number[] = [];
  const rightMembers: number[] = [];
  for (let i = 0; i < members.length; i += 1) {
    if (leftSide.has(i)) leftMembers.push(members[i]!);
    else rightMembers.push(members[i]!);
  }

  return [
    ...splitByMstCut(
      leftMembers,
      walkingDist,
      budgetMeters,
      minSize,
      depth + 1,
    ),
    ...splitByMstCut(
      rightMembers,
      walkingDist,
      budgetMeters,
      minSize,
      depth + 1,
    ),
  ];
}

/* --- internal -------------------------------------------------------------- */

interface MstEdge {
  from: number;
  to: number;
  weight: number;
}

/** Build an undirected graphology graph with `weight` attribute from edges. */
function buildWeightedGraph(
  nodeIds: readonly number[],
  edges: readonly WalkingEdge[],
  sigmaMeters: number,
): UndirectedGraph {
  const g = new UndirectedGraph();
  // Sort node ids before adding for determinism.
  for (const id of [...nodeIds].sort((a, b) => a - b)) {
    g.addNode(String(id));
  }
  for (const e of edges) {
    const a = String(e.fromCacheId);
    const b = String(e.toCacheId);
    if (!g.hasNode(a) || !g.hasNode(b)) continue;
    const weight = Math.exp(-e.meters / sigmaMeters);
    if (!g.hasEdge(a, b)) g.addEdge(a, b, { weight });
  }
  return g;
}

function internalEdgeWeightSum(
  ids: readonly number[],
  edges: readonly WalkingEdge[],
  sigmaMeters: number,
): number {
  const set = new Set(ids);
  let total = 0;
  for (const e of edges) {
    if (set.has(e.fromCacheId) && set.has(e.toCacheId)) {
      total += Math.exp(-e.meters / sigmaMeters);
    }
  }
  return total;
}

function jaccard(a: Set<number>, b: readonly number[]): number {
  let intersection = 0;
  for (const x of b) if (a.has(x)) intersection += 1;
  const union = a.size + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build the MST as an edge list via Prim's algorithm. Returns up to n-1 edges.
 * Distance is supplied as a closure so callers can use Euclidean or walking.
 */
function buildMstEdges(
  n: number,
  dist: (i: number, j: number) => number,
): { edges: MstEdge[] } {
  if (n <= 1) return { edges: [] };
  const inTree = new Array<boolean>(n).fill(false);
  const minDist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const parent = new Array<number>(n).fill(-1);
  minDist[0] = 0;
  const edges: MstEdge[] = [];
  for (let step = 0; step < n; step += 1) {
    let u = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (!inTree[j] && minDist[j]! < best) {
        best = minDist[j]!;
        u = j;
      }
    }
    if (u < 0) break;
    inTree[u] = true;
    const p = parent[u]!;
    if (p >= 0 && Number.isFinite(best)) {
      edges.push({ from: p, to: u, weight: best });
    }
    for (let v = 0; v < n; v += 1) {
      if (inTree[v]) continue;
      const d = dist(u, v);
      if (d < (minDist[v] ?? Number.POSITIVE_INFINITY)) {
        minDist[v] = d;
        parent[v] = u;
      }
    }
  }
  return { edges };
}

/**
 * Deterministic seeded RNG (mulberry32). Same seed → same sequence. Used for
 * Louvain's `rng` option so the resolution sweep is reproducible.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
