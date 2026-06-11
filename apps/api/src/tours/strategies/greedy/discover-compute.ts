// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure cluster-discovery pipeline (ADR-0014). This is the CPU-heavy
// "post-context" body of GreedyTspPlanner.discoverClusters, extracted so it can
// run inside the worker-thread pool without blocking the API event loop.
//
// PURITY CONTRACT: this module and everything it imports must be free of I/O,
// NestJS, services, and repositories — it runs in a worker. The main thread
// builds the (I/O-bound) `PreparedContext` and resolves `preferredLanduseKinds`
// (a DB read), then hands both to this function. Imports are restricted to pure
// modules: `clustering/refine`, `clustering/registry`, `cluster-scoring`,
// and `@gctp/shared`. `PreparedContext` is a TYPE-only import
// (erased at runtime) so `clustering/context.ts` — the I/O importer — never
// loads here.

import type { Tours } from "@gctp/shared";
import { Tsp } from "@gctp/shared";
import type { PreparedContext } from "./clustering/context.js";
import { refineClusters } from "./clustering/refine.js";
import { resolveClusteringStrategy } from "./clustering/registry.js";
import { scoreCluster } from "./cluster-scoring.js";

/** Default cut-off when PlanInput omits `topNClusters` (the zod schema already
 *  supplies 5; defensive). Mirrors the constant in greedy-tsp-planner.ts. */
const DEFAULT_TOP_N_CLUSTERS = 5;

/**
 * Run the pure clustering + refinement + scoring + diagnostics pipeline. Given
 * a prepared context (already I/O-built on the main thread), the resolved
 * strategy name, and the caller's preferred landuse kinds, produce the same
 * `DiscoverClustersResult` the inline implementation used to. Deterministic.
 */
export function computeClusters(
  ctx: PreparedContext,
  strategyName: Tours.ClusteringStrategyName,
  preferredLanduseKinds: readonly string[],
): Tours.DiscoverClustersResult {
  const strategy = resolveClusteringStrategy(strategyName, undefined);
  const input = ctx.input;

  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const clusterDistanceMeters = (a: number, b: number): number => {
    if (a === b) return 0;
    const ca = poolById.get(a);
    const cb = poolById.get(b);
    if (!ca || !cb) return Number.POSITIVE_INFINITY;
    return ctx.projection.distanceMeters(
      ca.location.coordinates,
      cb.location.coordinates,
    );
  };

  // 2. Run the chosen strategy.
  const raw = strategy.cluster(ctx);

  // 3. Shared refinement pipeline.
  const splitClusters = refineClusters(raw, ctx, strategy.skipRefinement);

  // 4. Score + sort.
  const scored = splitClusters.map((cacheIds) => {
    const cluster = cacheIds.map((id) => poolById.get(id)!).filter(Boolean);
    if (cluster.length !== cacheIds.length) {
      // Refinement returns pool-only ids; a hydration miss here means an
      // invariant got violated upstream. Warn (worker stderr) rather than
      // silently truncating.
      console.warn(
        `[discover-compute] ${cacheIds.length - cluster.length}/${cacheIds.length} cluster ids missing from poolById (refine→pool invariant broken)`,
      );
    }
    const mst = mstLengthByDistance(cluster.length, (i, j) =>
      clusterDistanceMeters(cluster[i]!.id, cluster[j]!.id),
    );
    // NN+2-opt closed-loop estimate; MST undershoots thin/chained clusters
    // (no closing leg). ×1.4 straight-line→walking so it's comparable to the
    // OSRM-routed length Pass 2 produces.
    const estimatedTourMeters = estimateTourLength(cluster.length, (i, j) =>
      clusterDistanceMeters(cluster[i]!.id, cluster[j]!.id),
    );
    const { total, breakdown } = scoreCluster({
      caches: cluster,
      mstLengthMeters: mst,
      estimatedTourMeters,
      distanceBudgetMeters: input.distanceBudgetMeters,
      softPrefs: input.softPreferences,
      landuseKindsByCacheId: ctx.landuseKindsByCacheId,
      preferredLanduseKinds,
      landuseWeight: input.softPreferences.landuseWeight ?? 1,
      projection: ctx.projection,
    });
    const meanLng = mean(cluster.map((c) => c.location.coordinates[0]!));
    const meanLat = mean(cluster.map((c) => c.location.coordinates[1]!));
    return {
      clusterId: stableClusterId(cluster.map((c) => c.id)),
      cacheIds: cluster.map((c) => c.id),
      centroid: {
        type: "Point" as const,
        coordinates: [meanLng, meanLat] as [number, number],
      },
      mstLengthMeters: round2(mst),
      estimatedTourMeters: round2(estimatedTourMeters),
      score: round4(total),
      scoreBreakdown: Object.fromEntries(
        Object.entries(breakdown).map(([k, v]) => [k, round4(v)]),
      ),
    } satisfies Tours.ClusterCandidate;
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0;
  });

  // Boundary guard: ClusterCandidate.cacheIds is `.min(2)` on the wire and
  // refinement is supposed to enforce minClusterSize. Filter + warn so a leak
  // can't crash the UI's response parser.
  const validCandidates = scored.filter((c) => c.cacheIds.length >= 2);
  if (validCandidates.length !== scored.length) {
    console.warn(
      `[discover-compute] dropped ${scored.length - validCandidates.length} sub-minimum candidate(s) — refine should have caught these`,
    );
  }

  // Diagnostics.
  const components: Tours.ClusterComponent[] =
    strategy.name === "louvain"
      ? ctx.subgraphs.map((sub) => ({
          cacheIds: sub.cacheIds.slice().sort((a, b) => a - b),
          mstLengthMeters: round2(
            mstLengthByDistance(sub.cacheIds.length, (i, j) =>
              clusterDistanceMeters(sub.cacheIds[i]!, sub.cacheIds[j]!),
            ),
          ),
          accepted: scored.some((c) =>
            c.cacheIds.some((id) => sub.cacheIds.includes(id)),
          ),
        }))
      : raw.map((r) => ({
          cacheIds: r.cacheIds.slice().sort((a, b) => a - b),
          mstLengthMeters: round2(
            mstLengthByDistance(r.cacheIds.length, (i, j) =>
              clusterDistanceMeters(r.cacheIds[i]!, r.cacheIds[j]!),
            ),
          ),
          accepted: scored.some((c) =>
            setsOverlap(new Set(c.cacheIds), r.cacheIds),
          ),
        }));

  const nearestById = new Map<number, number>();
  for (const e of ctx.edges) {
    const cur = nearestById.get(e.fromCacheId);
    if (cur === undefined || e.meters < cur)
      nearestById.set(e.fromCacheId, e.meters);
    const curRev = nearestById.get(e.toCacheId);
    if (curRev === undefined || e.meters < curRev)
      nearestById.set(e.toCacheId, e.meters);
  }
  const cacheConnectivity: Tours.CacheConnectivity[] = ctx.pool.map((c) => ({
    cacheId: c.id,
    nearestWalkableMeters: nearestById.has(c.id)
      ? round2(nearestById.get(c.id)!)
      : null,
  }));
  const landuseHits = ctx.pool.filter(
    (c) => (ctx.landuseKindsByCacheId.get(c.id) ?? []).length > 0,
  ).length;

  return {
    candidates: validCandidates.slice(
      0,
      input.topNClusters ?? DEFAULT_TOP_N_CLUSTERS,
    ),
    diagnostics: {
      epsilonMeters: strategy.epsilonMetersForDiagnostics(ctx),
      poolSize: ctx.pool.length,
      components,
      cacheConnectivity,
      seedCount: ctx.subgraphs.length,
      edgeCount: ctx.edges.length,
      landuseCoverageFraction:
        ctx.pool.length > 0 ? landuseHits / ctx.pool.length : 0,
      resolutionsUsed: louvainResolutionsFrom(raw),
      strategyUsed: strategy.name,
      strategyParams: strategy.paramsForDiagnostics(ctx),
    },
  };
}

// ─── Pure helpers (moved from greedy-tsp-planner.ts; discover-only) ──────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function setsOverlap(a: ReadonlySet<number>, b: readonly number[]): boolean {
  for (const x of b) if (a.has(x)) return true;
  return false;
}

function louvainResolutionsFrom(
  raw: ReadonlyArray<{ meta?: Record<string, number | string> }>,
): number[] {
  const seen = new Set<number>();
  for (const r of raw) {
    const v = r.meta?.resolution;
    if (typeof v === "number") seen.add(v);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * MST length via Prim's algorithm, parameterised by a distance function.
 * Quadratic in N — fine; N is capped at the cluster size.
 */
function mstLengthByDistance(
  n: number,
  dist: (i: number, j: number) => number,
): number {
  if (n <= 1) return 0;
  const inTree = new Array<boolean>(n).fill(false);
  const minDist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  minDist[0] = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
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
    if (Number.isFinite(best)) total += best;
    for (let v = 0; v < n; v += 1) {
      if (inTree[v]) continue;
      const d = dist(u, v);
      if (d < (minDist[v] ?? Number.POSITIVE_INFINITY)) minDist[v] = d;
    }
  }
  return total;
}

/**
 * Pass-1 closed-loop tour length estimate: NN seed + 2-opt over the cluster's
 * straight-line distances, ×1.4 to approximate OSRM walking. Runs synchronously
 * here — it's already inside the worker. Falls back to 0 on degenerate input.
 */
const STRAIGHT_LINE_TO_WALKING_FACTOR = 1.4;
function estimateTourLength(
  n: number,
  dist: (i: number, j: number) => number,
): number {
  if (n <= 1) return 0;
  if (n === 2) {
    const d = dist(0, 1);
    return Number.isFinite(d) ? d * 2 * STRAIGHT_LINE_TO_WALKING_FACTOR : 0;
  }
  const matrix: (number | null)[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: (number | null)[] = [];
    for (let j = 0; j < n; j += 1) {
      if (i === j) {
        row.push(0);
      } else {
        const d = dist(i, j);
        row.push(Number.isFinite(d) ? d : null);
      }
    }
    matrix.push(row);
  }
  const { totalDistance } = Tsp.solveTwoOpt(matrix, 0);
  if (!Number.isFinite(totalDistance)) return 0;
  return totalDistance * STRAIGHT_LINE_TO_WALKING_FACTOR;
}

function stableClusterId(cacheIds: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const id of cacheIds) {
    let v = id;
    for (let b = 0; b < 4; b += 1) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
