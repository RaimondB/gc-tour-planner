// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Caches, Geo, Routing, Tours } from "@gctp/shared";
import { Tsp } from "@gctp/shared";
import { CachesService } from "../../../caches/caches.service.js";
import { CachesRepository } from "../../../caches/caches.repository.js";
import { CacheLanduseRepository } from "../../../caches/cache-landuse.repository.js";
import { RoutingService } from "../../../routing/routing.service.js";
import { RoutingRepository } from "../../../routing/routing.repository.js";
import { OSRM_CLIENT, type OsrmClient } from "../../../routing/osrm.client.js";
import { scoreCluster } from "./cluster-scoring.js";
import { haversineMeters } from "./equirectangular.js";
import {
  discoverClustersInSubgraphs,
  splitByMstCut,
} from "./louvain-clusters.js";
import { extractSeedSubgraphs, selectSeeds } from "./seeds.js";
import { buildWalkingGraph, type WalkingEdge } from "./walking-graph.js";

const PROFILE: Routing.RoutingProfile = "foot";
const TOP_N_CLUSTERS = 5;
/** Hard cap so a misconfigured request doesn't make the planner OOM. */
const MAX_LOOP_CACHES = 50;
/**
 * Hard cap on candidate-pool size for Pass 1. Lifted from 300 → 2000 with the
 * sparse k-NN matrix redesign — N² OSRM cost no longer applies; cost scales
 * with N × k_target (~24k cells for N=2000, k=12). Whole-region scans (10k+)
 * are still bounded by the per-bbox PostGIS query the caller chooses.
 */
const MAX_DISCOVERY_POOL = 2000;
/**
 * Target k-nearest neighbours per cache in the sparse walking graph.
 * Caller over-fetches 3× and re-ranks by OSRM walking distance.
 * Tunable via env so we can measure on real PQ data without redeploys.
 */
const KNN_TARGET = Number.parseInt(process.env.PLANNER_KNN_K ?? "12", 10);

@Injectable()
export class GreedyTspPlanner implements Tours.TourPlannerStrategy {
  private readonly logger = new Logger(GreedyTspPlanner.name);

  constructor(
    private readonly caches: CachesService,
    private readonly cachesRepo: CachesRepository,
    private readonly cacheLanduse: CacheLanduseRepository,
    private readonly routing: RoutingService,
    private readonly routingRepo: RoutingRepository,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
  ) {}

  // ─── Pass 1: cluster discovery (Louvain-on-sparse-graph) ──────────────────
  //
  // See docs/adr/0002 + the redesign plan in
  // ~/.claude/plans/i-am-not-happy-functional-lobster.md. Flow:
  //   1. Load candidate pool (capped at MAX_DISCOVERY_POOL).
  //   2. Lazy-populate cache_landuse for the pool's bbox.
  //   3. Build sparse walking graph (PostGIS k-NN over-fetch + OSRM re-rank).
  //   4. Pick H3 density seeds + extract per-seed isochrone subgraphs.
  //   5. Louvain across a resolution sweep + Jaccard dedup.
  //   6. Safety-net MST-cut for any community exceeding budget/size.
  //   7. Score, sort, top-N.

  async discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    const { caches } = await this.caches.list(ownerId, {
      center: input.center,
      radiusM: input.radiusM,
      types: input.hardFilters.types,
      attributes: input.hardFilters.attributes,
      excludeFound: true,
    });

    if (caches.length < 2) {
      this.logger.debug(
        `discoverClusters: only ${caches.length} candidate caches — returning no clusters`,
      );
      return {
        candidates: [],
        diagnostics: {
          epsilonMeters: 0,
          poolSize: caches.length,
          components: [],
          cacheConnectivity: caches.map((c) => ({
            cacheId: c.id,
            nearestWalkableMeters: null,
          })),
          seedCount: 0,
          edgeCount: 0,
          landuseCoverageFraction: 0,
          resolutionsUsed: [],
        },
      };
    }

    const pool = caches.slice(0, MAX_DISCOVERY_POOL);
    if (caches.length > MAX_DISCOVERY_POOL) {
      this.logger.warn(
        `discoverClusters: ${caches.length} candidates exceeds MAX_DISCOVERY_POOL=${MAX_DISCOVERY_POOL}; trimming.`,
      );
    }
    const poolById = new Map(pool.map((c) => [c.id, c]));
    const coordinated = pool.map((c) => ({
      id: c.id,
      lng: c.location.coordinates[0]!,
      lat: c.location.coordinates[1]!,
    }));

    // 1. Lazy-populate cache_landuse for the pool's bbox (cheap if warm; the
    //    SQL fn is idempotent). Compute a tight bbox from the pool itself
    //    rather than the search radius so we don't pay for empty corners.
    const bbox = bboxOf(coordinated);
    await this.cacheLanduse
      .populateForBbox(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat)
      .catch((err) =>
        this.logger.warn(
          `cache_landuse populate failed (degrading gracefully): ${(err as Error).message}`,
        ),
      );
    const landuseKindsByCacheId = await this.cacheLanduse.kindsByCacheId(
      pool.map((c) => c.id),
    );

    // 2. Sparse walking graph. `maxEdgeMeters = maxLinkMeters` hard-caps
    //    any single edge — without it, river-crossing detours sneak into
    //    the top-k and Louvain fuses communities across them.
    const edges: WalkingEdge[] = await buildWalkingGraph(
      {
        ownerId,
        caches: coordinated,
        kTarget: KNN_TARGET,
        radiusM: Math.min(input.maxLinkMeters * 2, 4000),
        maxEdgeMeters: input.maxLinkMeters,
        profile: PROFILE,
      },
      { caches: this.cachesRepo, routing: this.routingRepo, osrm: this.osrm },
    );

    // 3. H3-density seeds + per-seed subgraphs.
    const seedIds = selectSeeds(coordinated, edges);
    const subgraphs = extractSeedSubgraphs(
      seedIds,
      edges,
      input.distanceBudgetMeters,
    );

    // 4. Louvain across resolutions on each subgraph.
    const sigmaMeters = input.distanceBudgetMeters / 4;
    const rawCandidates = discoverClustersInSubgraphs(subgraphs, {
      sigmaMeters,
    });

    // Cluster-spread metric for scoring + safety-net split. Use Haversine
    // (not the sparse walking graph): the sparse graph drops most pairs as
    // +Infinity, so summing only the few finite edges yields a meaningless
    // MST of a few hundred metres for a 10-cache cluster spanning kilometres.
    // Haversine is a robust geographic spread proxy; walking-detour cost is
    // handled in Pass 2 where the real OSRM matrix is computed.
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

    // Adjacency on the (already capped-by-maxEdgeMeters) walking graph for
    // outlier trimming: a cluster member with no walking-graph edge to any
    // other cluster member is geographically attached but not walk-connected
    // — Louvain put it there by global modularity, but it's not part of the
    // user's loop. Drop those before scoring.
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
    const trimOutliers = (cacheIds: readonly number[]): number[] => {
      const set = new Set(cacheIds);
      // Iterate until no more outliers — dropping one outlier might make a
      // previously-adjacent cache an outlier too if its only in-cluster
      // neighbour was the just-dropped node.
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
    };

    /**
     * Geographic outlier trim. A cache walking-connected via a long bridge
     * may legitimately satisfy `trimOutliers` (it has in-cluster walking-graph
     * edges) yet still sit visually far from the cluster's centre.
     *
     * Drop any cache whose distance to the cluster centroid exceeds
     * `min(2 × median, distanceBudget / 4)`. The absolute cap matters because
     * an over-stretched cluster (median 1500 m for an 8 km budget) would
     * otherwise tolerate 3 km outliers — sloppy for a walking loop. The
     * budget/4 cap is the same σ the Louvain weighting uses to define
     * "cluster scale", so the trim and the modularity agree on what's tight.
     *
     * Iterate until stable: dropping a far cache shifts the centroid, which
     * can newly-qualify another fringe cache as an outlier.
     *
     * Not every cache HAS to land in a cluster — sub-clusters that fall
     * below minClusterSize after this pass are discarded entirely (caller).
     */
    const absoluteCapMeters = input.distanceBudgetMeters / 4;
    const trimGeographicOutliers = (cacheIds: readonly number[]): number[] => {
      let ids = cacheIds.slice();
      let changed = true;
      while (changed && ids.length >= input.minClusterSize) {
        changed = false;
        const coords = ids
          .map((id) => poolById.get(id))
          .filter((c): c is Caches.CacheDTO => c !== undefined)
          .map((c) => [
            c.location.coordinates[0]!,
            c.location.coordinates[1]!,
          ] as [number, number]);
        const centroid: [number, number] = [
          mean(coords.map((c) => c[0])),
          mean(coords.map((c) => c[1])),
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
    };

    // 5. Safety-net split + two-stage trim + post-trim dedup.
    //
    // splitByMstCut keeps each surviving community within budget+size.
    // trimOutliers drops caches with no in-cluster walking-graph edge.
    // trimGeographicOutliers drops caches > min(2× median, budget/4)
    // from the centroid. Both iterate to a fixed point.
    //
    // Different raw Louvain candidates often collapse to the SAME trimmed
    // core (the resolution sweep gives several near-overlapping seeds, all
    // of which share the same dense pocket). Dedup AFTER trimming so the
    // user doesn't see five identical clusters with different ids.
    const splitClusters: number[][] = [];
    const seenSignatures = new Set<string>();
    for (const cand of rawCandidates) {
      const parts = splitByMstCut(
        cand.cacheIds,
        clusterDistanceMeters,
        input.distanceBudgetMeters,
        input.minClusterSize,
        input.maxCaches,
      );
      for (const part of parts) {
        const connTrimmed = trimOutliers(part);
        const geoTrimmed = trimGeographicOutliers(connTrimmed);
        if (geoTrimmed.length < input.minClusterSize) continue;
        const sig = geoTrimmed.slice().sort((a, b) => a - b).join(",");
        if (seenSignatures.has(sig)) continue;
        seenSignatures.add(sig);
        splitClusters.push(geoTrimmed);
      }
    }

    // 6. Score + sort.
    const preferredLanduseKinds = await this.kindsForLanduseProfile(
      input.softPreferences.landuseProfileId,
    );

    const scored = splitClusters.map((cacheIds) => {
      const cluster = cacheIds.map((id) => poolById.get(id)!).filter(Boolean);
      // MST over the cluster using Haversine — geographic spread, always
      // finite, robust against sparse-graph gaps that would otherwise make
      // a 10-cache cluster spanning kilometres report MST ≈ 20 m.
      const mst = mstLengthByDistance(cluster.length, (i, j) =>
        clusterDistanceMeters(cluster[i]!.id, cluster[j]!.id),
      );
      const { total, breakdown } = scoreCluster({
        caches: cluster,
        mstLengthMeters: mst,
        distanceBudgetMeters: input.distanceBudgetMeters,
        softPrefs: input.softPreferences,
        landuseKindsByCacheId,
        preferredLanduseKinds,
        landuseWeight: 1,
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

    // 7. Diagnostics — one component entry per seed subgraph (so the web UI
    //    can still show "we found N seed-anchored neighbourhoods of these
    //    sizes"). MST uses Haversine for the same reason as cluster scoring.
    const components: Tours.ClusterComponent[] = subgraphs.map((sub) => ({
      cacheIds: sub.cacheIds.slice().sort((a, b) => a - b),
      mstLengthMeters: round2(
        mstLengthByDistance(sub.cacheIds.length, (i, j) =>
          clusterDistanceMeters(sub.cacheIds[i]!, sub.cacheIds[j]!),
        ),
      ),
      accepted: scored.some((c) =>
        c.cacheIds.some((id) => sub.cacheIds.includes(id)),
      ),
    }));
    const nearestById = new Map<number, number>();
    for (const e of edges) {
      const cur = nearestById.get(e.fromCacheId);
      if (cur === undefined || e.meters < cur)
        nearestById.set(e.fromCacheId, e.meters);
      const curRev = nearestById.get(e.toCacheId);
      if (curRev === undefined || e.meters < curRev)
        nearestById.set(e.toCacheId, e.meters);
    }
    const cacheConnectivity: Tours.CacheConnectivity[] = pool.map((c) => ({
      cacheId: c.id,
      nearestWalkableMeters: nearestById.has(c.id)
        ? round2(nearestById.get(c.id)!)
        : null,
    }));
    const landuseHits = pool.filter((c) =>
      (landuseKindsByCacheId.get(c.id) ?? []).length > 0,
    ).length;

    return {
      candidates: scored.slice(0, TOP_N_CLUSTERS),
      diagnostics: {
        epsilonMeters: 0,
        poolSize: pool.length,
        components,
        cacheConnectivity,
        seedCount: seedIds.length,
        edgeCount: edges.length,
        landuseCoverageFraction:
          pool.length > 0 ? landuseHits / pool.length : 0,
        resolutionsUsed: Array.from(
          new Set(rawCandidates.map((c) => c.resolution)),
        ).sort((a, b) => a - b),
      },
    };
  }

  /**
   * Map a landuse profile id → kinds the profile considers "preferred".
   * Placeholder until a landuse_profiles table lands: for now the id IS the
   * kind (e.g. `landuseProfileId='forest'`). Empty when no profile selected.
   * Wired this way so the scoring code can stay generic.
   */
  private async kindsForLanduseProfile(
    profileId: string | undefined,
  ): Promise<string[]> {
    if (!profileId) return [];
    // TODO(M5-β): join landuse_profiles table once it exists.
    return [profileId];
  }

  // ─── Pass 2: routed closed loop ───────────────────────────────────────────

  async planLoop(
    ownerId: string,
    input: Tours.PlanLoopInput,
  ): Promise<Tours.PlanResult> {
    const ids = Array.from(new Set(input.cacheIds))
      .sort((a, b) => a - b)
      .slice(0, MAX_LOOP_CACHES);

    const cacheRows = await this.caches.findByIds(ownerId, ids);
    if (cacheRows.length !== ids.length) {
      const missing = ids.filter((id) => !cacheRows.some((c) => c.id === id));
      throw new NotFoundException(
        `Caches not found for this user: ${missing.join(", ")}`,
      );
    }
    const byId = new Map(cacheRows.map((c) => [c.id, c]));

    // Walking OD matrix for the picked set. Cells are null when OSRM can't
    // connect a pair — we drop nodes whose connectivity is too poor before
    // running TSP.
    const matrix = await this.routing.getMatrix(ownerId, ids, PROFILE);
    const { connectedIds, distances } = filterConnected(ids, matrix);
    if (connectedIds.length < 2) {
      throw new NotFoundException(
        "Selected caches are not mutually reachable on foot — pick a different cluster.",
      );
    }

    // Pick parking BEFORE TSP so we can anchor the tour to the cache nearest
    // parking and avoid an awkward parking-far-from-start configuration.
    const parking = await this.pickParking(
      input,
      connectedIds.map((id) => byId.get(id)!),
    );

    const startIndex = nearestCacheIndexTo(
      connectedIds.map((id) => byId.get(id)!),
      parking.point.coordinates as [number, number],
    );

    const { order: tspOrder } = Tsp.solveTwoOpt(distances, startIndex);
    const orderedIds = tspOrder.map((i) => connectedIds[i]!);

    // Pull leg geometry for every adjacent cache pair in the open path. The
    // closed loop's closing leg (orderedIds[last] → orderedIds[0]) is
    // replaced by the two parking legs below.
    const interCacheLegs: Routing.Leg[] = [];
    for (let i = 0; i < orderedIds.length - 1; i += 1) {
      const leg = await this.routing.getLeg(
        ownerId,
        orderedIds[i]!,
        orderedIds[i + 1]!,
        PROFILE,
      );
      if (leg) interCacheLegs.push(leg);
    }

    const firstCoord = byId
      .get(orderedIds[0]!)!
      .location.coordinates as [number, number];
    const lastCoord = byId
      .get(orderedIds[orderedIds.length - 1]!)!
      .location.coordinates as [number, number];
    const parkingCoord = parking.point.coordinates as [number, number];

    const [parkingToFirst, lastToParking] = await Promise.all([
      this.osrm.route(parkingCoord, firstCoord, PROFILE),
      this.osrm.route(lastCoord, parkingCoord, PROFILE),
    ]);
    if (!parkingToFirst || !lastToParking) {
      throw new NotFoundException(
        "OSRM could not connect parking to the chosen loop — try a different start preference.",
      );
    }

    const polyline = concatLineStrings([
      parkingToFirst.geometry,
      ...interCacheLegs.map((l) => l.geometry),
      lastToParking.geometry,
    ]);

    const interMeters = sum(interCacheLegs.map((l) => l.meters));
    const interSeconds = sum(interCacheLegs.map((l) => l.seconds));
    const meters = parkingToFirst.meters + interMeters + lastToParking.meters;
    const seconds =
      parkingToFirst.seconds + interSeconds + lastToParking.seconds;
    const visitMinutes = input.timePerCacheMinutes * orderedIds.length;

    return {
      orderedCacheIds: orderedIds,
      polyline,
      totals: {
        meters: round2(meters),
        seconds: round2(seconds),
        visitMinutes,
      },
      parking,
      scoreBreakdown: {
        tspLoopMeters: round2(meters),
        parkingDetourMeters: round2(
          parkingToFirst.meters + lastToParking.meters,
        ),
        budgetSlackMeters: round2(input.distanceBudgetMeters - meters),
      },
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async pickParking(
    input: Tours.PlanLoopInput,
    cluster: readonly Caches.CacheDTO[],
  ): Promise<Tours.ParkingChoice> {
    const meanLng = mean(cluster.map((c) => c.location.coordinates[0]!));
    const meanLat = mean(cluster.map((c) => c.location.coordinates[1]!));
    const centroid: [number, number] = [meanLng, meanLat];

    switch (input.startPreference) {
      case "user-supplied-point": {
        if (!input.userSuppliedStart) {
          throw new NotFoundException(
            "startPreference=user-supplied-point requires userSuppliedStart",
          );
        }
        return {
          type: "user",
          point: { type: "Point", coordinates: input.userSuppliedStart },
          reason: "User-supplied start point",
        };
      }
      case "osrm-nearest-road": {
        // OSRM's /nearest endpoint isn't exposed by our client yet — fall back
        // to the cluster centroid. The planner can be upgraded later when
        // OsrmClient grows .nearest(); the user-facing reason is honest.
        return {
          type: "osrm-nearest",
          point: { type: "Point", coordinates: centroid },
          reason:
            "Cluster centroid (OSRM /nearest snapping arrives in a later milestone)",
        };
      }
      case "parking-waypoint":
      default: {
        const best = pickBestPqParking(cluster, centroid);
        if (best) {
          return {
            type: "pq",
            point: { type: "Point", coordinates: best },
            reason: "Cache-owner parking waypoint nearest the cluster centroid",
          };
        }
        return {
          type: "osrm-nearest",
          point: { type: "Point", coordinates: centroid },
          reason:
            "No PQ parking waypoint in the cluster — fell back to cluster centroid",
        };
      }
    }
  }
}

// ─── Pure utilities ─────────────────────────────────────────────────────────

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return sum(xs) / xs.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function bboxOf(
  coords: readonly { lng: number; lat: number }[],
): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  let minLng = coords[0]?.lng ?? 0;
  let minLat = coords[0]?.lat ?? 0;
  let maxLng = minLng;
  let maxLat = minLat;
  for (const c of coords) {
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/**
 * MST length via Prim's algorithm, parameterised by a distance function so
 * the caller can supply either Euclidean or walking-distance metrics.
 *
 * Quadratic in N, fine here — N is capped at MAX_LOOP_CACHES = 50 for tours
 * and at the cluster size for scoring (caches are pre-filtered by the
 * Louvain pipeline). Used as the closed-tour lower bound: any TSP tour is
 * ≤ 2 × MST.
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

function stableClusterId(cacheIds: readonly number[]): string {
  // Sorted-id hash so the same cluster keeps the same id across runs. Plain
  // FNV-1a — we only need a short stable string, not crypto.
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

function pickBestPqParking(
  cluster: readonly Caches.CacheDTO[],
  centroid: readonly [number, number],
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  // Deterministic order: iterate caches by ascending id, parking points in
  // their original (insertion) order.
  const sorted = cluster.slice().sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    for (const p of c.parkingPoints) {
      const d = haversineMeters(centroid, p);
      if (d < bestDist) {
        bestDist = d;
        best = [p[0], p[1]];
      }
    }
  }
  return best;
}

function nearestCacheIndexTo(
  cluster: readonly Caches.CacheDTO[],
  to: readonly [number, number],
): number {
  let bestI = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cluster.length; i += 1) {
    const c = cluster[i]!;
    const d = haversineMeters(
      [c.location.coordinates[0]!, c.location.coordinates[1]!],
      to,
    );
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function filterConnected(
  ids: readonly number[],
  matrix: Routing.Matrix,
): { connectedIds: number[]; distances: (number | null)[][] } {
  // Drop any cache that has zero reachable peers — it would force +Infinity
  // into the tour and produce a meaningless result.
  const keep: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    let reachable = 0;
    for (let j = 0; j < ids.length; j += 1) {
      if (i === j) continue;
      if (matrix.legs[i]?.[j]) reachable += 1;
    }
    if (reachable > 0) keep.push(i);
  }
  const connectedIds = keep.map((i) => ids[i]!);
  const distances = keep.map((i) =>
    keep.map((j) => (i === j ? 0 : (matrix.legs[i]?.[j]?.meters ?? null))),
  );
  return { connectedIds, distances };
}

function concatLineStrings(
  lines: readonly Geo.GeoJsonLineString[],
): Geo.GeoJsonLineString {
  const coords: [number, number][] = [];
  for (const line of lines) {
    for (let i = 0; i < line.coordinates.length; i += 1) {
      const c = line.coordinates[i]!;
      const last = coords[coords.length - 1];
      // Drop the joining duplicate where one leg's end equals the next leg's start.
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      coords.push([c[0], c[1]]);
    }
  }
  if (coords.length < 2) {
    // GeoJSON LineString needs ≥ 2 points; duplicate the lone point so the
    // schema validates rather than throwing on edge-case zero-length tours.
    const p = coords[0] ?? [0, 0];
    coords.push([p[0], p[1]]);
  }
  return { type: "LineString", coordinates: coords };
}
