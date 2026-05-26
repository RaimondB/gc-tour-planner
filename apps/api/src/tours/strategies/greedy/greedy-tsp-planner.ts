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
import { OsrmVersionService } from "../../../routing/osrm-version.service.js";
import {
  CLUSTERING_STRATEGIES,
  prepareClusteringContext,
  refineClusters,
  resolveClusteringStrategy,
} from "./clustering/index.js";
import { scoreCluster } from "./cluster-scoring.js";
import { haversineMeters } from "./equirectangular.js";
import {
  OverlapGrid,
  pickAndAccumulate,
  readLoopOptionsFromEnv,
} from "./loop-aware-legs.js";
import {
  resolveMarginalTrimThreshold,
  trimMarginalCaches,
} from "./marginal-trim.js";

const PROFILE: Routing.RoutingProfile = "foot";
const TOP_N_CLUSTERS = 5;
/** Hard cap so a misconfigured request doesn't make the planner OOM. */
const MAX_LOOP_CACHES = 50;

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
    private readonly osrmVersion: OsrmVersionService,
  ) {}

  // ─── Pass 1: cluster discovery ────────────────────────────────────────────
  //
  // See docs/adr/0002. Pipeline:
  //   1. prepareClusteringContext: pool + landuse + sparse walking graph + seeds.
  //   2. Run the selected ClusteringStrategy (default louvain; configurable
  //      per-request via PlanInput.clusteringStrategy or globally via
  //      `PLANNER_CLUSTERING` env).
  //   3. refineClusters: shared MST-cut → walking-trim → geo-trim → Jaccard dedup.
  //   4. Score, sort, top-N.

  async discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    const strategy = resolveClusteringStrategy(
      input.clusteringStrategy,
      process.env.PLANNER_CLUSTERING,
    );

    const ctx = await prepareClusteringContext(ownerId, input, {
      caches: this.caches,
      cachesRepo: this.cachesRepo,
      cacheLanduse: this.cacheLanduse,
      routingRepo: this.routingRepo,
      osrm: this.osrm,
      osrmVersion: this.osrmVersion,
      logger: this.logger,
    });

    if (!ctx) {
      // Sub-2-cache pool — degenerate. Return an empty result that still
      // carries enough diagnostic context for the UI.
      const pool = (await this.caches.list(ownerId, {
        center: input.center,
        radiusM: input.radiusM,
        types: input.hardFilters.types,
        attributes: input.hardFilters.attributes,
        excludeFound: true,
      })).caches;
      return {
        candidates: [],
        diagnostics: {
          epsilonMeters: 0,
          poolSize: pool.length,
          components: [],
          cacheConnectivity: pool.map((c) => ({
            cacheId: c.id,
            nearestWalkableMeters: null,
          })),
          seedCount: 0,
          edgeCount: 0,
          landuseCoverageFraction: 0,
          resolutionsUsed: [],
          strategyUsed: strategy.name,
          strategyParams: {},
        },
      };
    }

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

    // 2. Run the chosen strategy.
    const raw = strategy.cluster(ctx);

    // 3. Shared refinement pipeline.
    const splitClusters = refineClusters(raw, ctx, strategy.skipRefinement);

    // 4. Score + sort.
    const preferredLanduseKinds = await this.kindsForLanduseProfile(
      input.softPreferences.landuseProfileId,
    );
    const scored = splitClusters.map((cacheIds) => {
      const cluster = cacheIds.map((id) => poolById.get(id)!).filter(Boolean);
      if (cluster.length !== cacheIds.length) {
        // Refinement returns pool-only ids, so a hydration miss here means
        // an invariant got violated upstream. Worth a warning so the leak
        // can be tracked down rather than silently truncating clusters.
        this.logger.warn(
          `scored: ${cacheIds.length - cluster.length}/${cacheIds.length} cluster ids missing from poolById (refine→pool invariant broken)`,
        );
      }
      const mst = mstLengthByDistance(cluster.length, (i, j) =>
        clusterDistanceMeters(cluster[i]!.id, cluster[j]!.id),
      );
      const { total, breakdown } = scoreCluster({
        caches: cluster,
        mstLengthMeters: mst,
        distanceBudgetMeters: input.distanceBudgetMeters,
        softPrefs: input.softPreferences,
        landuseKindsByCacheId: ctx.landuseKindsByCacheId,
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

    // Boundary guard: `ClusterCandidate.cacheIds` is `.min(2)` on the wire,
    // and refinement is also supposed to enforce minClusterSize. A leak past
    // both — observed in the field as a stray 1-cluster at the bottom of
    // the top-5 — would crash the UI's response parser. Filter and warn so
    // the response stays valid while we root-cause the leak.
    const validCandidates = scored.filter((c) => c.cacheIds.length >= 2);
    if (validCandidates.length !== scored.length) {
      this.logger.warn(
        `scored: dropped ${scored.length - validCandidates.length} sub-minimum candidate(s) before response — refine should have caught these`,
      );
    }

    // Diagnostics — components are still one-per-seed-subgraph for the
    // Louvain pipeline; for other strategies we report the raw clusters that
    // entered refinement so the user can see what the strategy actually found.
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
    const landuseHits = ctx.pool.filter((c) =>
      (ctx.landuseKindsByCacheId.get(c.id) ?? []).length > 0,
    ).length;

    return {
      candidates: validCandidates.slice(0, TOP_N_CLUSTERS),
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

  /** Read the resolution metadata Louvain attaches to raw candidates. Empty for other strategies. */
  // (Kept as a static helper so cluster diagnostics don't need to know which
  //  strategy ran — it just looks for the field.)

  /**
   * Map a landuse profile id → kinds the profile considers "preferred".
   * Placeholder until a landuse_profiles table lands: for now the id IS the
   * kind (e.g. `landuseProfileId='forest'`). Empty when no profile selected.
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

    const matrix = await this.routing.getMatrix(ownerId, ids, PROFILE);
    const { connectedIds, distances } = filterConnected(ids, matrix);
    if (connectedIds.length < 2) {
      throw new NotFoundException(
        "Selected caches are not mutually reachable on foot — pick a different cluster.",
      );
    }

    const parking = await this.pickParking(
      input,
      connectedIds.map((id) => byId.get(id)!),
    );

    const startIndex = nearestCacheIndexTo(
      connectedIds.map((id) => byId.get(id)!),
      parking.point.coordinates as [number, number],
    );

    const { order: tspOrder } = Tsp.solveTwoOpt(distances, startIndex);
    const initialOrderedIds = tspOrder.map((i) => connectedIds[i]!);

    // Parking distances to every cache — feeds the marginal-cost trim so
    // it can also consider trimming the FIRST and LAST cache in the
    // tour. Without this the worst case (cache stuck behind a barrier
    // lands at position N-1) is silently kept. One extra OSRM /table
    // call with [parking, ...caches] as origins.
    const parkingCoordForTable = parking.point.coordinates as [number, number];
    const cacheCoordsForTable = connectedIds.map<[number, number]>((id) => {
      const c = byId.get(id)!;
      return [
        c.location.coordinates[0]!,
        c.location.coordinates[1]!,
      ];
    });
    const parkingTable = await this.osrm.table(
      [parkingCoordForTable, ...cacheCoordsForTable],
      PROFILE,
    );
    // Row 0 = parking → each cache; column 0 = each cache → parking.
    const parkingToCacheM: number[] = connectedIds.map((_, i) => {
      const cell = parkingTable[0]?.[i + 1];
      return cell?.meters ?? Number.POSITIVE_INFINITY;
    });
    const cacheToParkingM: number[] = connectedIds.map((_, i) => {
      const cell = parkingTable[i + 1]?.[0];
      return cell?.meters ?? Number.POSITIVE_INFINITY;
    });

    // Marginal-cost trim: drop caches whose presence adds more walking
    // than they're worth — typically a cache stuck behind a single-bridge
    // barrier whose haversine distance looks reasonable but whose OSRM
    // walking route doubles back. See ./marginal-trim.ts for the why.
    // No-op when no cache exceeds the threshold (the common case).
    const trimThreshold = resolveMarginalTrimThreshold(distances);
    const trim = trimMarginalCaches({
      orderedIds: initialOrderedIds,
      originalIds: connectedIds,
      distances,
      parkingToCacheM,
      cacheToParkingM,
      thresholdMeters: trimThreshold,
      minRemaining: 2,
    });
    const orderedIds = trim.orderedIds;
    const droppedCacheIds = trim.droppedIds;
    if (droppedCacheIds.length > 0) {
      this.logger.debug(
        `marginal trim: dropped ${droppedCacheIds.length} cache(s) (~${Math.round(trim.savedMeters)} m saved, threshold=${Math.round(trimThreshold)} m): [${droppedCacheIds.join(", ")}]`,
      );
    }

    // Loop-aware polyline assembly: TSP fixes the order, but each leg gets
    // a chance to pick a non-overlapping alternative against the polyline
    // accumulated so far. Stops the tour from walking the same main street
    // twice in dense village clusters. See ./loop-aware-legs.ts.
    const loopOpts = readLoopOptionsFromEnv();
    const grid = new OverlapGrid(loopOpts.picker.gridMeters);
    const altCount = loopOpts.altCount;
    const firstCoord = byId
      .get(orderedIds[0]!)!
      .location.coordinates as [number, number];
    const lastCoord = byId
      .get(orderedIds[orderedIds.length - 1]!)!
      .location.coordinates as [number, number];
    const parkingCoord = parking.point.coordinates as [number, number];

    // Parking → first cache. No accumulated overlap yet, so this is always
    // the primary; running it through the picker is just for symmetry.
    const parkingToFirst = await pickAndAccumulate({
      from: parkingCoord,
      to: firstCoord,
      profile: PROFILE,
      count: altCount,
      fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
      grid,
      options: loopOpts.picker,
      logger: this.logger,
      label: "parking→first",
    });
    if (!parkingToFirst) {
      throw new NotFoundException(
        "OSRM could not connect parking to the chosen loop — try a different start preference.",
      );
    }

    // Inter-cache legs. Each picks an alternative least-overlapping with
    // the running polyline, so leg 2 prefers the side-street that avoids
    // leg 1's main road, etc.
    const interCacheLegs: Routing.Leg[] = [];
    for (let i = 0; i < orderedIds.length - 1; i += 1) {
      const fromId = orderedIds[i]!;
      const toId = orderedIds[i + 1]!;
      const fromC = byId.get(fromId)!.location.coordinates as [number, number];
      const toC = byId.get(toId)!.location.coordinates as [number, number];
      const picked = await pickAndAccumulate({
        from: fromC,
        to: toC,
        profile: PROFILE,
        count: altCount,
        fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
        fetchVia: this.osrm.routeMulti.bind(this.osrm),
        grid,
        options: loopOpts.picker,
        logger: this.logger,
        label: `leg ${i + 1}`,
      });
      if (picked) {
        interCacheLegs.push({
          fromCacheId: fromId,
          toCacheId: toId,
          profile: PROFILE,
          meters: picked.meters,
          seconds: picked.seconds,
          geometry: picked.geometry,
        });
      }
    }

    // Last cache → parking. Closes the loop; the picker still helps here
    // because the return leg has the entire outbound polyline to compare
    // against.
    const lastToParking = await pickAndAccumulate({
      from: lastCoord,
      to: parkingCoord,
      profile: PROFILE,
      count: altCount,
      fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
      grid,
      options: loopOpts.picker,
      logger: this.logger,
      label: "last→parking",
    });
    if (!lastToParking) {
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
      droppedCacheIds,
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
        marginalTrimDroppedCount: droppedCacheIds.length,
        marginalTrimSavedMeters: round2(trim.savedMeters),
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
        const snapped = await this.osrm.nearest(centroid, PROFILE);
        if (snapped) {
          return {
            type: "osrm-nearest",
            point: { type: "Point", coordinates: snapped },
            reason: "Cluster centroid snapped to nearest walkable road",
          };
        }
        return {
          type: "osrm-nearest",
          point: { type: "Point", coordinates: centroid },
          reason:
            "OSRM /nearest found no walkable road — using raw cluster centroid",
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

void CLUSTERING_STRATEGIES; // imported for side-effect-free type access; kept
                            // to surface a future "register a strategy" hook
                            // if we ever load strategies dynamically.

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
 * MST length via Prim's algorithm, parameterised by a distance function so
 * the caller can supply either Euclidean or walking-distance metrics.
 *
 * Quadratic in N, fine here — N is capped at MAX_LOOP_CACHES = 50 for tours
 * and at the cluster size for scoring.
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
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      coords.push([c[0], c[1]]);
    }
  }
  if (coords.length < 2) {
    const p = coords[0] ?? [0, 0];
    coords.push([p[0], p[1]]);
  }
  return { type: "LineString", coordinates: coords };
}
