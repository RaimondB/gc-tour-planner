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
import {
  OSRM_CLIENT,
  type OsrmClient,
  type OsrmLeg,
} from "../../../routing/osrm.client.js";
import { OsrmVersionService } from "../../../routing/osrm-version.service.js";
import { ParkingFacilitiesRepository } from "../../../osm/parking-facilities.repository.js";
import { LanduseProfilesRepository } from "../../../landuse-profiles/landuse-profiles.repository.js";
import { pickOsmParking } from "../pick-osm-parking.js";
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
/** Default cut-off when PlanInput omits `topNClusters` (defensive; the
 *  zod schema already supplies 5). */
const DEFAULT_TOP_N_CLUSTERS = 5;
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
    private readonly parkingFacilities: ParkingFacilitiesRepository,
    private readonly landuseProfiles: LanduseProfilesRepository,
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
      ownerId,
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
      // NN+2-opt closed-loop estimate on the same distance lookup. MST
      // is a 2-5× undershoot for thin/chained clusters because the
      // spanning tree never sees the closing leg back to the start —
      // the TSP estimate gives Pass 1 a realistic tour-length signal.
      // Multiplied by the haversine-to-walking factor below so the
      // estimate is comparable to the OSRM-routed length Pass 2 will
      // produce (NL urban foot routing is typically ~1.4× haversine).
      const estimatedTourMeters = estimateTourLength(
        cluster.length,
        (i, j) =>
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

  /** Read the resolution metadata Louvain attaches to raw candidates. Empty for other strategies. */
  // (Kept as a static helper so cluster diagnostics don't need to know which
  //  strategy ran — it just looks for the field.)

  /**
   * Map a landuse profile id → kinds the profile considers "preferred".
   * Reads `landuse_profiles` via `LanduseProfilesRepository` with the
   * caller's ownerId so system profiles + the user's own profiles are
   * both eligible, but other users' private profiles are silently
   * filtered. Returns an empty list when no profile is requested or
   * when the id is not visible to the caller — the planner's
   * `landuseMatch` term then zeroes out, matching pre-M5-β behaviour.
   */
  private async kindsForLanduseProfile(
    ownerId: string,
    profileId: string | undefined,
  ): Promise<string[]> {
    if (!profileId) return [];
    const profile = await this.landuseProfiles.findById(ownerId, profileId);
    return profile?.kinds ?? [];
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
    //
    // Threshold is the user-supplied `maxLinkMeters` (the same knob that
    // bounds Pass 1 cluster linking): if visiting a cache adds more than
    // that much walking over the skip distance, it's effectively not
    // "on" the route anymore. The legacy env-based threshold
    // (resolveMarginalTrimThreshold) is still imported for backward
    // compat but not used here; that formula was median-derived and
    // ignored the user's per-plan tolerance.
    const trimThreshold = input.maxLinkMeters;
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
    //
    // Wrapped in a fringe-trim iteration: after every full leg-build pass,
    // compute the actual marginal cost of each cache (its leg-in + leg-out
    // minus the prev→next "skip" distance). If any cache's marginal
    // exceeds `input.fringeTrimMeters`, drop it, re-run 2-opt on the
    // survivors, and rebuild the legs from scratch. This is the "try
    // alternatives first, only trim if they don't help" workflow — the
    // pre-trim above operates on OSRM-primary distances, this one
    // operates on the actual picked legs after the alternative-aware
    // picker has had its say.
    const loopOpts = readLoopOptionsFromEnv();
    const altCount = loopOpts.altCount;
    const parkingCoord = parking.point.coordinates as [number, number];
    const connectedIdToIdx = new Map<number, number>();
    for (let i = 0; i < connectedIds.length; i += 1) {
      connectedIdToIdx.set(connectedIds[i]!, i);
    }
    const distAt = (a: number, b: number): number => {
      const i = connectedIdToIdx.get(a);
      const j = connectedIdToIdx.get(b);
      if (i === undefined || j === undefined) return Number.POSITIVE_INFINITY;
      const v = distances[i]?.[j];
      return v === null || v === undefined ? Number.POSITIVE_INFINITY : v;
    };
    const parkingToCacheAt = (id: number): number => {
      const i = connectedIdToIdx.get(id);
      if (i === undefined) return Number.POSITIVE_INFINITY;
      const v = parkingToCacheM[i];
      return Number.isFinite(v ?? Number.POSITIVE_INFINITY)
        ? (v as number)
        : Number.POSITIVE_INFINITY;
    };
    const cacheToParkingAt = (id: number): number => {
      const i = connectedIdToIdx.get(id);
      if (i === undefined) return Number.POSITIVE_INFINITY;
      const v = cacheToParkingM[i];
      return Number.isFinite(v ?? Number.POSITIVE_INFINITY)
        ? (v as number)
        : Number.POSITIVE_INFINITY;
    };

    const POST_TRIM_MAX_ITERS = 3;
    let currentOrderedIds = orderedIds;
    // Routing.Leg + the per-leg alternatives the picker considered, so
    // we can surface them in PlanResult.legs for the manual-edit UI
    // without paying for OSRM again.
    type LegWithAlternatives = Routing.Leg & {
      alternatives: OsrmLeg[];
      selectedIndex: number;
    };
    let parkingToFirst!: LegWithAlternatives;
    let interCacheLegs!: LegWithAlternatives[];
    let lastToParking!: LegWithAlternatives;
    const postTrimDropped: number[] = [];

    for (let trimIter = 0; trimIter <= POST_TRIM_MAX_ITERS; trimIter += 1) {
      // Rebuild legs from scratch every iteration — the overlap grid
      // needs to forget the previous attempt's polyline.
      const grid = new OverlapGrid(loopOpts.picker.gridMeters);
      const firstCoord = byId
        .get(currentOrderedIds[0]!)!
        .location.coordinates as [number, number];
      const lastCoord = byId
        .get(currentOrderedIds[currentOrderedIds.length - 1]!)!
        .location.coordinates as [number, number];

      // Parking → first cache.
      const ptf = await pickAndAccumulate({
        from: parkingCoord,
        to: firstCoord,
        profile: PROFILE,
        count: altCount,
        fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
        grid,
        options: loopOpts.picker,
        logger: this.logger,
        label: `parking→first${trimIter > 0 ? ` (rebuild ${trimIter})` : ""}`,
      });
      if (!ptf) {
        throw new NotFoundException(
          "OSRM could not connect parking to the chosen loop — try a different start preference.",
        );
      }
      parkingToFirst = {
        fromCacheId: 0,
        toCacheId: currentOrderedIds[0]!,
        profile: PROFILE,
        meters: ptf.picked.meters,
        seconds: ptf.picked.seconds,
        geometry: ptf.picked.geometry,
        alternatives: ptf.alternatives,
        selectedIndex: ptf.selectedIndex,
      };

      // Inter-cache legs.
      interCacheLegs = [];
      for (let i = 0; i < currentOrderedIds.length - 1; i += 1) {
        const fromId = currentOrderedIds[i]!;
        const toId = currentOrderedIds[i + 1]!;
        const fromC = byId.get(fromId)!.location.coordinates as [
          number,
          number,
        ];
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
          label: `leg ${i + 1}${trimIter > 0 ? ` (rebuild ${trimIter})` : ""}`,
        });
        if (picked) {
          interCacheLegs.push({
            fromCacheId: fromId,
            toCacheId: toId,
            profile: PROFILE,
            meters: picked.picked.meters,
            seconds: picked.picked.seconds,
            geometry: picked.picked.geometry,
            alternatives: picked.alternatives,
            selectedIndex: picked.selectedIndex,
          });
        }
      }

      // Last cache → parking.
      const ltp = await pickAndAccumulate({
        from: lastCoord,
        to: parkingCoord,
        profile: PROFILE,
        count: altCount,
        fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
        grid,
        options: loopOpts.picker,
        logger: this.logger,
        label: `last→parking${trimIter > 0 ? ` (rebuild ${trimIter})` : ""}`,
      });
      if (!ltp) {
        throw new NotFoundException(
          "OSRM could not connect parking to the chosen loop — try a different start preference.",
        );
      }
      lastToParking = {
        fromCacheId: currentOrderedIds[currentOrderedIds.length - 1]!,
        toCacheId: 0,
        profile: PROFILE,
        meters: ltp.picked.meters,
        seconds: ltp.picked.seconds,
        geometry: ltp.picked.geometry,
        alternatives: ltp.alternatives,
        selectedIndex: ltp.selectedIndex,
      };

      // Decide what counts as a "fringe". The intuitive definition is
      // "you walked down a spur and back up the same way" — i.e., the
      // cache's leg-in and leg-out share significant pavement. A long
      // *coherent* loop detour (different streets in vs out) isn't a
      // fringe even when it adds significant meters; the user explicitly
      // wants those preserved. So instead of trimming on
      // (legIn + legOut − skip), we trim on the redundant-walking
      // estimate: how many meters of legOut overlap legIn (in either
      // direction), measured via a small grid hash of legIn's coords.
      if (
        currentOrderedIds.length <= 2 ||
        trimIter === POST_TRIM_MAX_ITERS
      ) {
        break;
      }
      const overlapGridMeters = loopOpts.picker.gridMeters;
      const meanCoordSpacing = (leg: Routing.Leg): number => {
        const n = leg.geometry.coordinates.length;
        return n > 1 ? leg.meters / (n - 1) : leg.meters;
      };
      const redundantMeters = (legIn: Routing.Leg, legOut: Routing.Leg): number => {
        const g = new OverlapGrid(overlapGridMeters);
        g.addLine(legIn.geometry);
        const hits = g.overlapHits(legOut.geometry);
        return hits * meanCoordSpacing(legOut);
      };

      let worstId: number | undefined;
      let worstRedundant = input.fringeTrimMeters;
      for (let i = 0; i < currentOrderedIds.length; i += 1) {
        const id = currentOrderedIds[i]!;
        let legIn: Routing.Leg;
        let legOut: Routing.Leg;
        if (i === 0) {
          legIn = parkingToFirst;
          legOut = interCacheLegs[0]!;
        } else if (i === currentOrderedIds.length - 1) {
          legIn = interCacheLegs[i - 1]!;
          legOut = lastToParking;
        } else {
          legIn = interCacheLegs[i - 1]!;
          legOut = interCacheLegs[i]!;
        }
        const redundant = redundantMeters(legIn, legOut);
        if (redundant > worstRedundant) {
          worstRedundant = redundant;
          worstId = id;
        }
      }
      if (worstId === undefined) break;
      const worstMarginal = worstRedundant; // used by debug log below

      // Drop the worst, re-run 2-opt on survivors. The 2-opt restart
      // matters because removing a node may make a previously-bad order
      // suddenly optimal in a different rotation.
      this.logger.debug(
        `post-trim iter ${trimIter}: dropping cache ${worstId} (redundant ${Math.round(
          worstMarginal,
        )}m of overlap between leg-in/leg-out > fringeTrimMeters ${input.fringeTrimMeters}m); rebuilding legs`,
      );
      postTrimDropped.push(worstId);
      const survivingIds = currentOrderedIds.filter((id) => id !== worstId);
      const survivingIdxs = survivingIds
        .map((id) => connectedIdToIdx.get(id))
        .filter((i): i is number => i !== undefined);
      const subDistances = survivingIdxs.map((srcIdx) =>
        survivingIdxs.map((dstIdx) => {
          const v = distances[srcIdx]?.[dstIdx];
          return v === undefined || v === null ? null : v;
        }),
      );
      // Start at the cache nearest to parking in the survivor set.
      const survivingCaches = survivingIds.map((id) => byId.get(id)!);
      const startIdx = nearestCacheIndexTo(survivingCaches, parkingCoord);
      const { order: subOrder } = Tsp.solveTwoOpt(subDistances, startIdx);
      currentOrderedIds = subOrder.map((i) => survivingIds[i]!);
    }

    const orderedIdsFinal = currentOrderedIds;
    droppedCacheIds.push(...postTrimDropped);

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
    const visitMinutes = input.timePerCacheMinutes * orderedIdsFinal.length;

    // Project the in-memory legs into the wire shape PlanResult.legs[]
    // expects. Parking endpoints use the sentinel cache id 0. Each leg
    // carries every alternative the picker considered + the index of
    // the selected one, so the manual-edit UI can offer leg-route
    // swaps without re-querying OSRM.
    const allLegs: LegWithAlternatives[] = [
      parkingToFirst,
      ...interCacheLegs,
      lastToParking,
    ];
    const legs: Tours.PlanLeg[] = allLegs.map((l, idx) => ({
      index: idx,
      fromCacheId: l.fromCacheId,
      toCacheId: l.toCacheId,
      meters: round2(l.meters),
      seconds: round2(l.seconds),
      geometry: l.geometry,
      alternatives: l.alternatives.map((a) => ({
        meters: round2(a.meters),
        seconds: round2(a.seconds),
        geometry: a.geometry,
      })),
      selectedAlternativeIndex: l.selectedIndex,
    }));

    return {
      orderedCacheIds: orderedIdsFinal,
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
      legs,
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
      case "osm-parking": {
        const osm = await pickOsmParking(
          this.parkingFacilities,
          this.osrm,
          input,
          cluster,
          centroid,
        );
        if (osm) return osm;
        // No walkable OSM parking inside maxLinkMeters — fall back to
        // OSRM-nearest so the planner still produces a tour. The reason
        // string makes the fallback visible in the UI.
        return {
          type: "osrm-nearest",
          point: { type: "Point", coordinates: centroid },
          reason:
            "No walkable OSM amenity=parking within maxLinkMeters — fell back to cluster centroid",
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

/**
 * Pass-1 closed-loop tour length estimate via Nearest-Neighbour seed +
 * 2-opt. Reuses the cluster's distance function (haversine over the
 * cluster's caches), then multiplies by an empirical haversine→walking
 * factor so the estimate is comparable to the OSRM-walked length Pass 2
 * produces. Calibrated on NL urban foot routing: ratio of OSRM walking
 * to straight-line is consistently 1.3-1.5; 1.4 is the middle.
 *
 * Cost: O(N²) matrix build + O(N² × iterations) inside `solveTwoOpt`.
 * For N=14 it's a sub-millisecond computation; for N=50 (the cluster
 * cap) it's still well under 10 ms. Per-cluster work; called once per
 * candidate in `scored.map`.
 *
 * On degenerate inputs (N < 2 or NaN distances) returns the MST length
 * as a conservative fallback — the caller in scoreCluster also falls
 * back to MST when estimatedTourMeters is 0, so this is belt-and-braces.
 */
const HAVERSINE_TO_WALKING_FACTOR = 1.4;
function estimateTourLength(
  n: number,
  dist: (i: number, j: number) => number,
): number {
  if (n <= 1) return 0;
  if (n === 2) {
    // Single round-trip — exactly 2× the leg, no TSP work needed.
    const d = dist(0, 1);
    return Number.isFinite(d) ? d * 2 * HAVERSINE_TO_WALKING_FACTOR : 0;
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
  return totalDistance * HAVERSINE_TO_WALKING_FACTOR;
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
