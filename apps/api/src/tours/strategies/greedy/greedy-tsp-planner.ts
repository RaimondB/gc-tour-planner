// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Caches, Geo, Routing, Tours } from "@gctp/shared";
import { hasToolRequirement } from "@gctp/shared/caches";
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
import { CarRoadsRepository } from "../../../osm/car-roads.repository.js";
import { LanduseProfilesRepository } from "../../../landuse-profiles/landuse-profiles.repository.js";
import { enumerateOsmParking } from "../pick-osm-parking.js";
import { enumeratePqParking } from "../pick-pq-parking.js";
import {
  prepareClusteringContext,
  resolveClusteringStrategy,
} from "./clustering/index.js";
import { haversineMeters } from "./equirectangular.js";
import {
  COMPUTE_POOL,
  type ComputePool,
} from "../../compute/compute-pool.service.js";
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
/** Default number of nearest car-road segments to consider as `osrm-nearest-road`
 *  parking candidates. Override with `PLANNER_ROAD_CANDIDATES`. */
const DEFAULT_ROAD_CANDIDATES = 12;

/** Read `PLANNER_ROAD_CANDIDATES` (clamped to [1, 50]); falls back to
 *  {@link DEFAULT_ROAD_CANDIDATES} when unset/unparseable. */
function readRoadCandidateLimit(): number {
  const raw = Number(process.env.PLANNER_ROAD_CANDIDATES);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_ROAD_CANDIDATES;
  return Math.min(50, Math.floor(raw));
}

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
    private readonly carRoads: CarRoadsRepository,
    private readonly landuseProfiles: LanduseProfilesRepository,
    @Inject(COMPUTE_POOL) private readonly computePool: ComputePool,
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
      const pool = (
        await this.caches.list(ownerId, {
          center: input.center,
          radiusM: input.radiusM,
          types: input.hardFilters.types,
          attributes: input.hardFilters.attributes,
          solvedMysteriesOnly: input.hardFilters.solvedMysteriesOnly,
          multiSubtype: input.hardFilters.multiSubtype,
          hideToolCaches: input.hardFilters.hideToolCaches,
          contexts: input.hardFilters.contexts,
          excludeFound: true,
        })
      ).caches;
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

    // Preferred landuse kinds is a DB read — resolve on the main thread, then
    // hand the (serializable) context + strategy name + kinds to the worker
    // pool. The CPU-heavy clustering + refinement + scoring + diagnostics run
    // off the event loop in `computeClusters` (ADR-0014); the result is the
    // same DiscoverClustersResult the inline pipeline produced.
    const preferredLanduseKinds = await this.kindsForLanduseProfile(
      ownerId,
      input.softPreferences.landuseProfileId,
    );
    return this.computePool.computeClusters(
      ctx,
      strategy.name,
      preferredLanduseKinds,
    );
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

    // Build the cache cycle BEFORE choosing parking so parking selection can
    // be loop-aware. 2-opt is anchored on the centroid's nearest cache (a
    // parking-independent, deterministic seed); the cycle topology is what we
    // score candidates against and later rotate, so the seed only picks which
    // local optimum we land in — the final attach point comes from
    // `bestParkingInsertion`, not from this anchor.
    const connectedCaches = connectedIds.map((id) => byId.get(id)!);
    const centroid: [number, number] = [
      mean(connectedCaches.map((c) => c.location.coordinates[0]!)),
      mean(connectedCaches.map((c) => c.location.coordinates[1]!)),
    ];
    const startIndex = nearestCacheIndexTo(connectedCaches, centroid);

    // TSP solve runs on the worker pool (ADR-0014) — never on the event loop.
    const { order: tspOrder } = await this.computePool.solveTwoOpt(
      distances,
      startIndex,
    );
    const initialOrderedIds = tspOrder.map((i) => connectedIds[i]!);

    // Pick parking. For multi-candidate modes (osm-parking, PQ waypoints) this
    // scores every candidate by its cheapest insertion edge into the cycle
    // above and keeps the minimum — i.e. the lot that adds the least walking
    // to the *tour*, not merely the closest one to a single cache.
    const parking = await this.selectParking(
      input,
      connectedIds,
      connectedCaches,
      centroid,
      initialOrderedIds,
      distances,
    );

    // Parking distances to every cache — feeds the marginal-cost trim so
    // it can also consider trimming the FIRST and LAST cache in the
    // tour. Without this the worst case (cache stuck behind a barrier
    // lands at position N-1) is silently kept. One extra OSRM /table
    // call with [parking, ...caches] as origins.
    const parkingCoordForTable = parking.point.coordinates as [number, number];
    const cacheCoordsForTable = connectedIds.map<[number, number]>((id) => {
      const c = byId.get(id)!;
      return [c.location.coordinates[0]!, c.location.coordinates[1]!];
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
    const trim = await trimMarginalCaches({
      orderedIds: initialOrderedIds,
      originalIds: connectedIds,
      distances,
      parkingToCacheM,
      cacheToParkingM,
      thresholdMeters: trimThreshold,
      minRemaining: 2,
      // Re-order survivors on the worker pool, not the event loop.
      solve: (d, s) => this.computePool.solveTwoOpt(d, s),
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
    // Attach parking at the cheapest cycle edge rather than the fixed
    // last→first edge 2-opt happened to leave. See the helper for why.
    let currentOrderedIds = rotateForBestParkingInsertion(
      orderedIds,
      parkingToCacheAt,
      cacheToParkingAt,
      distAt,
    );
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
      const firstCoord = byId.get(currentOrderedIds[0]!)!.location
        .coordinates as [number, number];
      const lastCoord = byId.get(
        currentOrderedIds[currentOrderedIds.length - 1]!,
      )!.location.coordinates as [number, number];

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
      if (currentOrderedIds.length <= 2 || trimIter === POST_TRIM_MAX_ITERS) {
        break;
      }
      const overlapGridMeters = loopOpts.picker.gridMeters;
      const meanCoordSpacing = (leg: Routing.Leg): number => {
        const n = leg.geometry.coordinates.length;
        return n > 1 ? leg.meters / (n - 1) : leg.meters;
      };
      const redundantMeters = (
        legIn: Routing.Leg,
        legOut: Routing.Leg,
      ): number => {
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
      const { order: subOrder } = await this.computePool.solveTwoOpt(
        subDistances,
        startIdx,
      );
      currentOrderedIds = rotateForBestParkingInsertion(
        subOrder.map((i) => survivingIds[i]!),
        parkingToCacheAt,
        cacheToParkingAt,
        distAt,
      );
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
    // FR-SF7: each cache that needs a tool gets `toolBonusMinutes`
    // on top of `timePerCacheMinutes`. The bonus counts attribute-
    // tagged tool caches (TOOL_ATTRIBUTE_IDS) and descriptionHints
    // matches together (see `hasToolRequirement`). Only affects the
    // returned `totals.visitMinutes` — distance budget, parking
    // selection, and leg picking still use the flat per-cache time.
    let toolStopCount = 0;
    for (const id of orderedIdsFinal) {
      const c = byId.get(id);
      if (!c) continue;
      if (hasToolRequirement(c.attributeIds, c.descriptionHints))
        toolStopCount += 1;
    }
    const visitMinutes =
      input.timePerCacheMinutes * orderedIdsFinal.length +
      input.toolBonusMinutes * toolStopCount;

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

  private async selectParking(
    input: Tours.PlanLoopInput,
    connectedIds: readonly number[],
    cluster: readonly Caches.CacheDTO[],
    centroid: [number, number],
    baseCycleIds: readonly number[],
    distances: (number | null)[][],
  ): Promise<Tours.ParkingChoice> {
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
          reason: "Manually picked start point",
          fallback: false,
        };
      }
      case "osrm-nearest-road": {
        const picked = await this.tryCarRoadParking(
          input,
          cluster,
          baseCycleIds,
          connectedIds,
          distances,
        );
        // No eligible car road reachable (rural gap, or the car_roads table
        // is absent, e.g. in Testcontainers) — fall back to the foot-snap of
        // the centroid so a plan is always produced.
        return picked ?? this.osrmNearestParking(centroid);
      }
      case "osm-parking": {
        const picked = await this.tryOsmParking(
          input,
          centroid,
          cluster,
          baseCycleIds,
          connectedIds,
          distances,
        );
        // No OSM parking reachable within maxLinkMeters — fall back to the
        // cluster centroid. The `fallback` flag makes that visible in the UI.
        return (
          picked ??
          this.centroidFallback(
            centroid,
            "No public parking within range — starting at cluster centroid",
          )
        );
      }
      case "auto": {
        // Try every source in turn; the first that yields a feasible start
        // (one reachable within maxLinkMeters) wins. Order: cache-owner
        // parking → public OSM parking → nearest car-accessible road.
        const picked =
          (await this.tryPqParking(
            cluster,
            baseCycleIds,
            connectedIds,
            distances,
            input.maxLinkMeters,
          )) ??
          (await this.tryOsmParking(
            input,
            centroid,
            cluster,
            baseCycleIds,
            connectedIds,
            distances,
          )) ??
          (await this.tryCarRoadParking(
            input,
            cluster,
            baseCycleIds,
            connectedIds,
            distances,
          ));
        return (
          picked ??
          this.centroidFallback(
            centroid,
            "No parking found near this cluster — starting at cluster centroid",
          )
        );
      }
      case "parking-waypoint":
      default: {
        const picked = await this.tryPqParking(
          cluster,
          baseCycleIds,
          connectedIds,
          distances,
          input.maxLinkMeters,
        );
        return (
          picked ??
          this.centroidFallback(
            centroid,
            "No cache-owner parking near this cluster — starting at cluster centroid",
          )
        );
      }
    }
  }

  /** Cache-owner (PQ) parking waypoints, scored loop-aware. `null` when none
   *  is reachable within `maxLinkMeters`. */
  private tryPqParking(
    cluster: readonly Caches.CacheDTO[],
    baseCycleIds: readonly number[],
    connectedIds: readonly number[],
    distances: (number | null)[][],
    maxLinkMeters: number,
  ): Promise<Tours.ParkingChoice | null> {
    const choices = enumeratePqParking(cluster).map<Tours.ParkingChoice>(
      (p) => ({
        type: "pq",
        point: { type: "Point", coordinates: p },
        reason: "Cache-owner parking waypoint",
        fallback: false,
      }),
    );
    return this.pickLoopAwareParking(
      choices,
      baseCycleIds,
      connectedIds,
      cluster,
      distances,
      maxLinkMeters,
    );
  }

  /** Public OSM amenity=parking facilities, scored loop-aware (ADR-0011).
   *  `null` when none is reachable within `maxLinkMeters`. */
  private async tryOsmParking(
    input: Tours.PlanLoopInput,
    centroid: [number, number],
    cluster: readonly Caches.CacheDTO[],
    baseCycleIds: readonly number[],
    connectedIds: readonly number[],
    distances: (number | null)[][],
  ): Promise<Tours.ParkingChoice | null> {
    const choices = (
      await enumerateOsmParking(this.parkingFacilities, input, centroid)
    ).map<Tours.ParkingChoice>((c) => {
      const label = c.name ?? `osm-${c.osmType}/${c.osmId}`;
      return {
        type: "osm",
        point: { type: "Point", coordinates: c.point },
        reason: `OSM amenity=parking — ${label} (access=${c.access ?? "unknown"}, fee=${c.fee ?? "unknown"})`,
        fallback: false,
        osm: {
          osmId: c.osmId,
          osmType: c.osmType,
          access: c.access,
          fee: c.fee,
          name: c.name,
        },
      };
    });
    return this.pickLoopAwareParking(
      choices,
      baseCycleIds,
      connectedIds,
      cluster,
      distances,
      input.maxLinkMeters,
    );
  }

  /** Nearest car-accessible road snap points, scored loop-aware (ADR-0012).
   *  `null` when none is reachable (or the car_roads table is absent). */
  private async tryCarRoadParking(
    input: Tours.PlanLoopInput,
    cluster: readonly Caches.CacheDTO[],
    baseCycleIds: readonly number[],
    connectedIds: readonly number[],
    distances: (number | null)[][],
  ): Promise<Tours.ParkingChoice | null> {
    // Snap parking onto the *car-accessible* roads closest to the tour path
    // (ADR-0012). Pass the ordered cycle (closed) so candidates are ranked by
    // proximity to the legs, not just the centroid.
    const byIdCoord = new Map<number, [number, number]>(
      cluster.map((c) => [c.id, c.location.coordinates as [number, number]]),
    );
    const tourPath = baseCycleIds
      .map((id) => byIdCoord.get(id))
      .filter((p): p is [number, number] => p !== undefined);
    if (tourPath.length > 0) tourPath.push(tourPath[0]!); // close the loop
    const choices = await this.enumerateCarRoadParking(
      tourPath,
      input.maxLinkMeters,
    );
    return this.pickLoopAwareParking(
      choices,
      baseCycleIds,
      connectedIds,
      cluster,
      distances,
      input.maxLinkMeters,
    );
  }

  /** Centroid fallback used when no source yields a feasible start. Flagged
   *  `fallback: true` so the UI can render a distinct "no parking" marker. */
  private centroidFallback(
    centroid: [number, number],
    reason: string,
  ): Tours.ParkingChoice {
    return {
      type: "osrm-nearest",
      point: { type: "Point", coordinates: centroid },
      reason,
      fallback: true,
    };
  }

  /**
   * Enumerate car-accessible road snap points near the tour path as parking
   * candidates (ADR-0012). Each is the closest point on a quiet, drivable
   * road to the loop; the caller scores them with `pickLoopAwareParking`. The
   * number of road segments considered is bounded by `PLANNER_ROAD_CANDIDATES`
   * (default 12) to keep the loop-aware OSRM `/table` small. Returns `[]` when
   * the table is empty / no eligible road is in range, so the caller falls
   * back to the foot-snap.
   */
  private async enumerateCarRoadParking(
    tourPath: readonly [number, number][],
    maxLinkMeters: number,
  ): Promise<Tours.ParkingChoice[]> {
    const limit = readRoadCandidateLimit();
    let candidates;
    try {
      candidates = await this.carRoads.findNearestRoadPoints(
        tourPath,
        maxLinkMeters,
        { limit },
      );
    } catch (err) {
      // car_roads not imported yet (or query failed) — degrade gracefully to
      // the foot-snap fallback rather than failing the whole plan.
      this.logger.warn(
        `car-road parking lookup failed; falling back to OSRM foot-snap: ${String(err)}`,
      );
      return [];
    }
    return candidates.map<Tours.ParkingChoice>((c) => ({
      type: "osrm-nearest",
      point: { type: "Point", coordinates: c.point },
      reason: `Car-accessible road — ${c.name ?? c.highway}`,
      fallback: false,
    }));
  }

  /** OSRM-nearest-road fallback: snap the centroid to a walkable node, or use
   *  the raw centroid when OSRM finds nothing. Used when no car road is
   *  reachable (see {@link enumerateCarRoadParking}). */
  private async osrmNearestParking(
    centroid: [number, number],
  ): Promise<Tours.ParkingChoice> {
    const snapped = await this.osrm.nearest(centroid, PROFILE);
    if (snapped) {
      return {
        type: "osrm-nearest",
        point: { type: "Point", coordinates: snapped },
        reason: "Cluster centroid snapped to nearest walkable road",
        fallback: true,
      };
    }
    return {
      type: "osrm-nearest",
      point: { type: "Point", coordinates: centroid },
      reason:
        "OSRM /nearest found no walkable road — using raw cluster centroid",
      fallback: true,
    };
  }

  /**
   * Loop-aware parking choice. Scores every candidate by its cheapest
   * insertion edge into the cache cycle (`bestParkingInsertion`) and returns
   * the minimum-cost one — the lot that adds the least walking to the *tour*,
   * not merely the closest to a single cache. A single batched OSRM `/table`
   * (candidates × caches, both directions) supplies the walking distances.
   * Candidates whose shortest walk to any cache exceeds `maxLinkMeters` are
   * dropped (the bogus-route guard the per-candidate pickers used to apply).
   * Returns `null` when no candidate is both reachable and finite-cost, so the
   * caller can fall back to OSRM-nearest.
   */
  private async pickLoopAwareParking(
    choices: readonly Tours.ParkingChoice[],
    baseCycleIds: readonly number[],
    connectedIds: readonly number[],
    cluster: readonly Caches.CacheDTO[],
    distances: (number | null)[][],
    maxLinkMeters: number,
  ): Promise<Tours.ParkingChoice | null> {
    if (choices.length === 0) return null;

    const C = choices.length;
    const cacheCoords = cluster.map<[number, number]>((c) => [
      c.location.coordinates[0]!,
      c.location.coordinates[1]!,
    ]);
    const candPoints = choices.map(
      (ch) => ch.point.coordinates as [number, number],
    );
    // One matrix call: rows/cols 0..C-1 are candidates, C..C+N-1 are caches.
    const table = await this.osrm.table(
      [...candPoints, ...cacheCoords],
      PROFILE,
    );

    const idxOf = new Map<number, number>();
    connectedIds.forEach((id, i) => idxOf.set(id, i));
    const distAt = (a: number, b: number): number => {
      const i = idxOf.get(a);
      const j = idxOf.get(b);
      if (i === undefined || j === undefined) return Number.POSITIVE_INFINITY;
      const v = distances[i]?.[j];
      return v == null ? Number.POSITIVE_INFINITY : v;
    };

    let best: Tours.ParkingChoice | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestWalk = Number.POSITIVE_INFINITY;
    for (let ci = 0; ci < C; ci += 1) {
      const toCache = (id: number): number => {
        const j = idxOf.get(id);
        if (j === undefined) return Number.POSITIVE_INFINITY;
        return table[ci]?.[C + j]?.meters ?? Number.POSITIVE_INFINITY;
      };
      const fromCache = (id: number): number => {
        const j = idxOf.get(id);
        if (j === undefined) return Number.POSITIVE_INFINITY;
        return table[C + j]?.[ci]?.meters ?? Number.POSITIVE_INFINITY;
      };
      // Reachability guard: the closest cache must be within the link cap,
      // otherwise this is a bogus cross-river route — same rule the old
      // per-candidate pickers applied before scoring.
      let minWalk = Number.POSITIVE_INFINITY;
      for (const id of connectedIds) {
        const w = toCache(id);
        if (w < minWalk) minWalk = w;
      }
      if (!Number.isFinite(minWalk) || minWalk > maxLinkMeters) continue;

      const { cost } = bestParkingInsertion(
        baseCycleIds,
        toCache,
        fromCache,
        distAt,
      );
      if (!Number.isFinite(cost)) continue;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestWalk = minWalk;
        best = choices[ci]!;
      }
    }
    if (!best) return null;
    return {
      ...best,
      reason: `${best.reason} — loop-aware pick (+${Math.round(bestCost)} m detour, ~${Math.round(bestWalk)} m walk to nearest cache)`,
    };
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

/**
 * Rotate a closed cache cycle so that parking attaches at its cheapest edge.
 *
 * The planner always builds the loop as `parking → first … last → parking`,
 * i.e. parking splits the cycle's `(last → first)` edge. 2-opt pins position 0
 * to the cache nearest the parking point, so without this rotation the *exit*
 * edge is just whatever the seed left adjacent to that pinned start — often a
 * long hop clear across the cluster (observed: a 504 m return leg). This is the
 * classic depot-insertion step: the cache cycle's edge sum is invariant under
 * rotation, so the loop total is minimised by picking the edge where inserting
 * parking costs the least — `parking→next + prev→parking − prev→next`.
 *
 * Distances come from the directional parking⇄cache walking tables (symmetric
 * in practice, but we keep the direction correct). `i === 0` reproduces the old
 * `last→first` behaviour and wins ties, so this is a strict, deterministic
 * improvement: the returned order is never longer than the input rotation.
 */
/**
 * Cheapest place to attach parking to a closed cache cycle.
 *
 * The loop is always built as `parking → first … last → parking`, so parking
 * splits exactly one cycle edge `(prev → next)`. Since the cache-cycle edge
 * sum is invariant under rotation, the loop total is minimised by the edge
 * with the smallest insertion cost `parking→next + prev→parking − prev→next`.
 * The `− prev→next` term is a geometric proxy for retrace: splitting a *long*
 * edge means parking sits "on the way" (cheap); splitting a *short* one makes
 * parking an out-and-back spur (expensive).
 *
 * Returns the start index that should become position 0 plus that edge's cost.
 * `start = 0` reproduces the old `last→first` behaviour and wins ties, so
 * rotating to it is a strict, deterministic improvement. Used both to rotate a
 * chosen loop and to score parking candidates against the same cycle.
 */
export function bestParkingInsertion(
  orderedIds: readonly number[],
  parkingToCacheAt: (id: number) => number,
  cacheToParkingAt: (id: number) => number,
  distAt: (a: number, b: number) => number,
): { start: number; cost: number } {
  const k = orderedIds.length;
  if (k === 0) return { start: 0, cost: Number.POSITIVE_INFINITY };
  if (k === 1) {
    const only = orderedIds[0]!;
    return { start: 0, cost: parkingToCacheAt(only) + cacheToParkingAt(only) };
  }
  let bestStart = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 0; i < k; i += 1) {
    const next = orderedIds[i]!; // becomes the first cache
    const prev = orderedIds[i === 0 ? k - 1 : i - 1]!; // becomes the last cache
    const inOut = parkingToCacheAt(next) + cacheToParkingAt(prev);
    if (!Number.isFinite(inOut)) continue;
    const skipped = distAt(prev, next);
    const cost = inOut - (Number.isFinite(skipped) ? skipped : 0);
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      bestStart = i;
    }
  }
  return { start: bestStart, cost: bestCost };
}

/** Rotate a cache cycle so parking attaches at its cheapest edge (see
 *  {@link bestParkingInsertion}). No-op when no finite insertion exists. */
export function rotateForBestParkingInsertion(
  orderedIds: readonly number[],
  parkingToCacheAt: (id: number) => number,
  cacheToParkingAt: (id: number) => number,
  distAt: (a: number, b: number) => number,
): number[] {
  if (orderedIds.length <= 1) return orderedIds.slice();
  const { start, cost } = bestParkingInsertion(
    orderedIds,
    parkingToCacheAt,
    cacheToParkingAt,
    distAt,
  );
  if (!Number.isFinite(cost)) return orderedIds.slice();
  return [...orderedIds.slice(start), ...orderedIds.slice(0, start)];
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
