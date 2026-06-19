// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Logger } from "@nestjs/common";
import type { Caches, Tours } from "@gctp/shared";
import type { CacheLanduseRepository } from "../../../../caches/cache-landuse.repository.js";
import type { CachesRepository } from "../../../../caches/caches.repository.js";
import type { CachesService } from "../../../../caches/caches.service.js";
import type { OsrmClient } from "../../../../routing/osrm.client.js";
import type { OsrmVersionService } from "../../../../routing/osrm-version.service.js";
import type { RoutingRepository } from "../../../../routing/routing.repository.js";
import { scoreCluster } from "../cluster-scoring.js";
import { haversineMeters } from "../equirectangular.js";
import type { SeedSubgraph } from "../seeds.js";
import type { WalkingEdge } from "../walking-graph.js";
import {
  CLUSTERING_STRATEGIES,
  prepareClusteringContext,
  projectMstSplit,
  projectTrims,
  refineClusters,
} from "./index.js";
import type { ClusteringContext } from "./strategy.js";

const logger = new Logger("ExplainSelection");

/**
 * Diagnose an arbitrary cache-id selection in the same Pass-1 context the
 * planner would build. Powers `POST /tours/clusters/explain` — see
 * [packages/shared/src/tours/explain-cluster.ts] for the full response shape.
 */
export async function explainSelection(
  ownerId: string,
  input: Tours.ExplainClusterInput,
  deps: {
    caches: CachesService;
    cachesRepo: CachesRepository;
    cacheLanduse: CacheLanduseRepository;
    routingRepo: RoutingRepository;
    osrm: OsrmClient;
    osrmVersion: OsrmVersionService;
  },
): Promise<Tours.ExplainClusterResponse> {
  // Reuse the planner's Pass-1 prelude by forging a minimal PlanInput.
  const planInput: Tours.PlanInput = {
    center: input.center,
    radiusM: input.radiusM,
    minClusterSize: input.minClusterSize,
    maxLinkMeters: input.maxLinkMeters,
    distanceBudgetMeters: input.distanceBudgetMeters,
    hardFilters: input.hardFilters,
    softPreferences: {
      clusterDensityWeight: 1,
      loopCompactnessWeight: 1,
      landuseWeight: 1,
    },
    startPreference: "parking-waypoint",
    osmParkingAccessFilter: ["yes", "customers"],
    osmParkingFeeFilter: "any",
    topNClusters: 5,
    clusteringStrategy: input.clusteringStrategy,
    // Debug/analytic path operates on the existing pool — never triggers
    // external enrichment.
    includeAdventureLabs: false,
  };

  const ctx = await prepareClusteringContext(ownerId, planInput, {
    caches: deps.caches,
    cachesRepo: deps.cachesRepo,
    cacheLanduse: deps.cacheLanduse,
    routingRepo: deps.routingRepo,
    osrm: deps.osrm,
    osrmVersion: deps.osrmVersion,
    logger,
  });

  if (!ctx) {
    return emptyResponse(input.cacheIds);
  }

  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const selectionIds = input.cacheIds.slice().sort((a, b) => a - b);
  const selectionSet = new Set(selectionIds);

  // Pull cached walking cells from route_legs covering every pair the explain
  // output will reference. Without this, `walkingM` is sourced from
  // `ctx.edges`, which is the post-cap, post-top-k=12 sparse graph — pairs
  // that have a perfectly good cached cell but exceeded `maxEdgeMeters`
  // showed up as `null` and looked like "OSRM had no route".
  //
  // The set is bounded: selection×selection (≤ 50²) + selection×top-8 pool
  // neighbours (≤ 50×16 with both directions) — well under the matrix sizes
  // we already handle in Pass 2.
  const cellMap = await buildCachedCellMap(
    selectionIds,
    ctx,
    deps.routingRepo,
    deps.osrmVersion.getVersion(),
  );

  // 1. Selection geometry.
  const selection = describeSelection(selectionIds, ctx);

  // 2. Per-cache info — does each id still survive the pool query?
  const caches = describeSelectionCaches(selectionIds, ctx, cellMap);

  // 3. Edges within the selection.
  const edges = describeSelectionEdges(
    selectionIds,
    ctx,
    selectionSet,
    cellMap,
  );

  // 4. Refinement projection.
  const trims = projectTrims(selectionIds, ctx);
  const refinement = {
    walkingOutlierTrim: { wouldDrop: trims.walkingOutliersDropped },
    geographicOutlierTrim: {
      wouldDrop: trims.geographicOutliersDropped,
      centroid: trims.centroid,
      medianFromCentroidM: trims.medianFromCentroidM,
      capM: trims.capM,
    },
    mstCut: {
      wouldSplitInto: projectMstSplit(selectionIds, ctx),
    },
  };

  // 5. Per-strategy partition restricted to the selection. Build a derived
  //    context whose pool/edges/subgraphs cover only the selection so each
  //    strategy answers "what would you do if these were the only caches?"
  const perStrategy = runStrategiesOnSelection(ctx, selectionIds);

  // 6. Attribution: run each strategy on the FULL pool with shared refinement
  //    and report the candidate that best matches the selection by Jaccard.
  const algorithmAttribution = computeAttribution(ctx, selectionIds);

  return {
    selection,
    caches,
    edges,
    refinement,
    perStrategy,
    algorithmAttribution,
  };
}

/* --- helpers ------------------------------------------------------------ */

function emptyResponse(
  cacheIds: readonly number[],
): Tours.ExplainClusterResponse {
  return {
    selection: {
      cacheIds: cacheIds.slice(),
      boundingDiameterM: 0,
      medianPairwiseM: 0,
      walkingLoopLowerBoundM: 0,
      withinBudget: false,
      score: { total: 0, breakdown: {} },
    },
    caches: [],
    edges: [],
    refinement: {
      walkingOutlierTrim: { wouldDrop: [] },
      geographicOutlierTrim: {
        wouldDrop: [],
        centroid: [0, 0],
        medianFromCentroidM: 0,
        capM: 0,
      },
      mstCut: { wouldSplitInto: [] },
    },
    perStrategy: {
      louvain: emptyOutcome(),
      leiden: emptyOutcome(),
      dbscan: emptyOutcome(),
      hdbscan: emptyOutcome(),
      "hdbscan-star": emptyOutcome(),
      components: emptyOutcome(),
    },
    algorithmAttribution: [],
  };
}

function emptyOutcome(): Tours.StrategyOutcome {
  return { clustersWithinSelection: [], noise: [], params: {} };
}

function describeSelection(
  selectionIds: readonly number[],
  ctx: ClusteringContext,
): Tours.ExplainClusterResponse["selection"] {
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const present = selectionIds
    .map((id) => poolById.get(id))
    .filter((c): c is Caches.CacheDTO => c !== undefined);

  // Pairwise haversine.
  const pairs: number[] = [];
  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      pairs.push(
        haversineMeters(
          [
            present[i]!.location.coordinates[0]!,
            present[i]!.location.coordinates[1]!,
          ],
          [
            present[j]!.location.coordinates[0]!,
            present[j]!.location.coordinates[1]!,
          ],
        ),
      );
    }
  }
  const sortedPairs = pairs.slice().sort((a, b) => a - b);
  const median =
    sortedPairs.length === 0
      ? 0
      : (sortedPairs[Math.floor(sortedPairs.length / 2)] ?? 0);
  const diameter = sortedPairs.length === 0 ? 0 : (sortedPairs.at(-1) ?? 0);

  // MST × 2 lower bound on a closed-loop walk.
  const mst = mstLengthByDistance(present.length, (i, j) => {
    if (i === j) return 0;
    return haversineMeters(
      [
        present[i]!.location.coordinates[0]!,
        present[i]!.location.coordinates[1]!,
      ],
      [
        present[j]!.location.coordinates[0]!,
        present[j]!.location.coordinates[1]!,
      ],
    );
  });
  const loopLowerBound = mst * 2;

  const score = scoreCluster({
    caches: present,
    mstLengthMeters: mst,
    estimatedTourMeters: loopLowerBound,
    distanceBudgetMeters: ctx.input.distanceBudgetMeters,
    softPrefs: ctx.input.softPreferences,
    landuseKindsByCacheId: new Map(),
    preferredLanduseKinds: [],
    landuseWeight: 0,
    projection: ctx.projection,
  });

  return {
    cacheIds: selectionIds.slice(),
    boundingDiameterM: round2(diameter),
    medianPairwiseM: round2(median),
    walkingLoopLowerBoundM: round2(loopLowerBound),
    withinBudget: loopLowerBound <= ctx.input.distanceBudgetMeters,
    score: {
      total: round4(score.total),
      breakdown: Object.fromEntries(
        Object.entries(score.breakdown).map(([k, v]) => [k, round4(v)]),
      ),
    },
  };
}

function describeSelectionCaches(
  selectionIds: readonly number[],
  ctx: ClusteringContext,
  cellMap: ReadonlyMap<string, { meters: number; seconds: number }>,
): Tours.ExplainCache[] {
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  // Symmetrise the cell map — when both directions are cached, report the
  // MIN (walking-honest distance, matching ctx.edges). When only one
  // direction is cached, report that one so the user sees what we know.
  const walkingByPair = symmetrisePairMap(cellMap);
  return selectionIds.map<Tours.ExplainCache>((id) => {
    const c = poolById.get(id);
    if (!c) {
      return {
        id,
        code: "",
        name: "(not in pool)",
        lng: 0,
        lat: 0,
        inCandidatePool: false,
        nearestKnnInPool: [],
      };
    }
    const lng = c.location.coordinates[0]!;
    const lat = c.location.coordinates[1]!;
    // K-nearest in the candidate pool by haversine — gives the user a peek at
    // what the algorithm saw as "near" before walking-graph filtering.
    const ranked = ctx.pool
      .filter((other) => other.id !== id)
      .map((other) => {
        const oLng = other.location.coordinates[0]!;
        const oLat = other.location.coordinates[1]!;
        const haversine = haversineMeters([lng, lat], [oLng, oLat]);
        const walk = walkingByPair.get(pairKey(id, other.id));
        return {
          id: other.id,
          haversineM: round2(haversine),
          walkingM: walk ? round2(walk.meters) : null,
          walkingS: walk ? round2(walk.seconds) : null,
        };
      })
      .sort((a, b) => a.haversineM - b.haversineM)
      .slice(0, 8);
    return {
      id,
      code: c.code,
      name: c.name,
      lng: round6(lng),
      lat: round6(lat),
      inCandidatePool: true,
      nearestKnnInPool: ranked,
    };
  });
}

function describeSelectionEdges(
  selectionIds: readonly number[],
  ctx: ClusteringContext,
  selectionSet: ReadonlySet<number>,
  cellMap: ReadonlyMap<string, { meters: number; seconds: number }>,
): Tours.ExplainEdge[] {
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  // Prefer cached cells over the post-cap walking-graph values. The walking
  // graph used to drop heavily asymmetric pairs entirely; now it admits
  // them with MIN. Either way, the user should see the *cached* walking
  // distance — `inWalkingGraph` keeps the "passed the cap?" signal explicit.
  const walkingByPair = symmetrisePairMap(cellMap);
  const inGraph = new Set<string>();
  for (const e of ctx.edges) inGraph.add(pairKey(e.fromCacheId, e.toCacheId));

  const out: Tours.ExplainEdge[] = [];
  for (let i = 0; i < selectionIds.length; i += 1) {
    for (let j = i + 1; j < selectionIds.length; j += 1) {
      const a = selectionIds[i]!;
      const b = selectionIds[j]!;
      if (!selectionSet.has(a) || !selectionSet.has(b)) continue;
      const ca = poolById.get(a);
      const cb = poolById.get(b);
      if (!ca || !cb) continue;
      const haversine = haversineMeters(
        [ca.location.coordinates[0]!, ca.location.coordinates[1]!],
        [cb.location.coordinates[0]!, cb.location.coordinates[1]!],
      );
      const walk = walkingByPair.get(pairKey(a, b));
      const referenceM = walk?.meters ?? haversine;
      out.push({
        a,
        b,
        haversineM: round2(haversine),
        walkingM: walk ? round2(walk.meters) : null,
        walkingS: walk ? round2(walk.seconds) : null,
        inWalkingGraph: inGraph.has(pairKey(a, b)),
        withinMaxLink: referenceM <= ctx.input.maxLinkMeters,
      });
    }
  }
  return out;
}

/**
 * Filter the prepared context down to a derived context covering only the
 * selection — used by `perStrategy` so we can ask "what would Louvain do
 * with just these caches?"
 */
function selectionContext(
  ctx: ClusteringContext,
  selectionIds: readonly number[],
): ClusteringContext {
  const idSet = new Set(selectionIds);
  const pool = ctx.pool.filter((c) => idSet.has(c.id));
  const coordinated = ctx.coordinated.filter((c) => idSet.has(c.id));
  const edges: WalkingEdge[] = ctx.edges.filter(
    (e) => idSet.has(e.fromCacheId) && idSet.has(e.toCacheId),
  );
  // One synthetic subgraph containing the whole selection — Louvain needs at
  // least one to run, and the seeded H3 partitioning is meaningless on a
  // user-picked set of ≤50 caches.
  const subgraphs: SeedSubgraph[] =
    selectionIds.length >= 2
      ? [
          {
            seedId: selectionIds[0]!,
            cacheIds: selectionIds.slice(),
            edges,
          },
        ]
      : [];
  return {
    pool,
    coordinated,
    edges,
    subgraphs,
    // Relax minClusterSize so strategies don't drop sub-clusters that are
    // legitimately small for an arbitrary user pick.
    input: { ...ctx.input, minClusterSize: 2 },
    // Same search centre, so the request's projection still applies.
    projection: ctx.projection,
  };
}

function runStrategiesOnSelection(
  ctx: ClusteringContext,
  selectionIds: readonly number[],
): Tours.ExplainClusterResponse["perStrategy"] {
  const derived = selectionContext(ctx, selectionIds);
  const selectionSet = new Set(selectionIds);
  const result: Tours.ExplainClusterResponse["perStrategy"] = {
    louvain: emptyOutcome(),
    leiden: emptyOutcome(),
    dbscan: emptyOutcome(),
    hdbscan: emptyOutcome(),
    "hdbscan-star": emptyOutcome(),
    components: emptyOutcome(),
  };
  for (const [name, strategy] of Object.entries(CLUSTERING_STRATEGIES)) {
    const raw = strategy.cluster(derived);
    const clusters = raw.map((r) =>
      r.cacheIds.filter((id) => selectionSet.has(id)).sort((a, b) => a - b),
    );
    const clustered = new Set<number>();
    for (const c of clusters) for (const id of c) clustered.add(id);
    const noise = selectionIds.filter((id) => !clustered.has(id));
    result[name as Tours.ClusteringStrategyName] = {
      clustersWithinSelection: clusters.filter((c) => c.length > 0),
      noise,
      params: strategy.paramsForDiagnostics(derived),
    };
  }
  return result;
}

function computeAttribution(
  ctx: ClusteringContext,
  selectionIds: readonly number[],
): Tours.ExplainClusterResponse["algorithmAttribution"] {
  const selectionSet = new Set(selectionIds);
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const out: Tours.ExplainClusterResponse["algorithmAttribution"] = [];
  for (const [name, strategy] of Object.entries(CLUSTERING_STRATEGIES)) {
    const raw = strategy.cluster(ctx);
    const refined = refineClusters(raw, ctx, strategy.skipRefinement);
    let best: { members: number[]; jaccard: number } | null = null;
    for (const members of refined) {
      const j = jaccard(new Set(members), selectionSet);
      if (best === null || j > best.jaccard) best = { members, jaccard: j };
    }
    if (!best || best.jaccard === 0) {
      out.push({
        strategy: name as Tours.ClusteringStrategyName,
        matchedCandidate: null,
        jaccard: 0,
      });
      continue;
    }
    const cluster = best.members
      .map((id) => poolById.get(id))
      .filter((c): c is Caches.CacheDTO => c !== undefined);
    const mst = mstLengthByDistance(cluster.length, (i, j) =>
      cluster[i] && cluster[j]
        ? haversineMeters(
            [
              cluster[i]!.location.coordinates[0]!,
              cluster[i]!.location.coordinates[1]!,
            ],
            [
              cluster[j]!.location.coordinates[0]!,
              cluster[j]!.location.coordinates[1]!,
            ],
          )
        : 0,
    );
    // Explain mode is analytic-only; we don't compute the TSP estimate
    // here (it's just MST × 2 as a cheap stand-in). The actual planner
    // path uses the real NN+2-opt estimate.
    const score = scoreCluster({
      caches: cluster,
      mstLengthMeters: mst,
      estimatedTourMeters: mst * 2,
      distanceBudgetMeters: ctx.input.distanceBudgetMeters,
      softPrefs: ctx.input.softPreferences,
      landuseKindsByCacheId: new Map(),
      preferredLanduseKinds: [],
      landuseWeight: 0,
      projection: ctx.projection,
    });
    const meanLng = mean(cluster.map((c) => c.location.coordinates[0]!));
    const meanLat = mean(cluster.map((c) => c.location.coordinates[1]!));
    out.push({
      strategy: name as Tours.ClusteringStrategyName,
      matchedCandidate: {
        clusterId: stableClusterId(cluster.map((c) => c.id)),
        cacheIds: cluster.map((c) => c.id),
        centroid: {
          type: "Point",
          coordinates: [meanLng, meanLat],
        },
        mstLengthMeters: round2(mst),
        estimatedTourMeters: round2(mst * 2),
        score: round4(score.total),
        scoreBreakdown: Object.fromEntries(
          Object.entries(score.breakdown).map(([k, v]) => [k, round4(v)]),
        ),
      },
      jaccard: round4(best.jaccard),
    });
  }
  return out;
}

function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Fetch every cached walking-cell `route_legs` knows about for the pairs the
 * explain output will display. Keyed by directional `${from}:${to}` — caller
 * symmetrises with `symmetrisePairMap` when it wants the MAX-of-both-directions
 * value (the same value ctx.edges holds for pairs that made the graph).
 *
 * Pair set: selection×selection (directional both ways) + selection×top-8
 * haversine pool neighbours (both directions). Top-8 mirrors the slice
 * `describeSelectionCaches` shows, so every value the UI renders is backed by
 * a real lookup rather than appearing as `null` for "wasn't in the graph".
 */
async function buildCachedCellMap(
  selectionIds: readonly number[],
  ctx: ClusteringContext,
  routingRepo: RoutingRepository,
  osrmVersion: string,
): Promise<Map<string, { meters: number; seconds: number }>> {
  const pairSet = new Set<string>();
  const pairs: { fromCacheId: number; toCacheId: number }[] = [];
  const addPair = (from: number, to: number) => {
    if (from === to) return;
    const k = `${from}:${to}`;
    if (pairSet.has(k)) return;
    pairSet.add(k);
    pairs.push({ fromCacheId: from, toCacheId: to });
  };

  // a. selection × selection (both directions).
  for (const a of selectionIds) {
    for (const b of selectionIds) addPair(a, b);
  }

  // b. selection × top-8-by-haversine pool neighbours (both directions).
  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  for (const sid of selectionIds) {
    const sc = poolById.get(sid);
    if (!sc) continue;
    const slng = sc.location.coordinates[0]!;
    const slat = sc.location.coordinates[1]!;
    const top8 = ctx.pool
      .filter((o) => o.id !== sid)
      .map((o) => ({
        id: o.id,
        h: haversineMeters(
          [slng, slat],
          [o.location.coordinates[0]!, o.location.coordinates[1]!],
        ),
      }))
      .sort((a, b) => a.h - b.h)
      .slice(0, 8);
    for (const t of top8) {
      addPair(sid, t.id);
      addPair(t.id, sid);
    }
  }

  if (pairs.length === 0) return new Map();
  const rows = await routingRepo.findMatrixCells(pairs, "foot", osrmVersion);
  const out = new Map<string, { meters: number; seconds: number }>();
  for (const r of rows) {
    // Skip noroute markers — the explain endpoint reports actual
    // walking distances; a known-no-route pair carries no meters to
    // surface, so we just omit it.
    if (r.noroute) continue;
    out.set(`${r.fromCacheId}:${r.toCacheId}`, {
      meters: r.meters,
      seconds: r.seconds,
    });
  }
  return out;
}

/**
 * Collapse a directional `${from}:${to}` cell map into an undirected
 * `pairKey(a,b)` map. When both directions are present we keep the MIN of
 * meters/seconds — walking is structurally bidirectional, so a large
 * asymmetry is almost always an OSRM artefact in the larger direction.
 * This matches the symmetrise rule the walking-graph builder uses for
 * `ctx.edges`. When only one direction exists we keep it as-is.
 */
function symmetrisePairMap(
  directional: ReadonlyMap<string, { meters: number; seconds: number }>,
): Map<string, { meters: number; seconds: number }> {
  const out = new Map<string, { meters: number; seconds: number }>();
  for (const [key, cell] of directional) {
    const [fromStr, toStr] = key.split(":");
    if (!fromStr || !toStr) continue;
    const a = Number(fromStr);
    const b = Number(toStr);
    const pk = pairKey(a, b);
    const existing = out.get(pk);
    if (!existing) {
      out.set(pk, { meters: cell.meters, seconds: cell.seconds });
    } else {
      out.set(pk, {
        meters: Math.min(existing.meters, cell.meters),
        seconds: Math.min(existing.seconds, cell.seconds),
      });
    }
  }
  return out;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
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
