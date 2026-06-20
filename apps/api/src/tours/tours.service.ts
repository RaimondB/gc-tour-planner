// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Tours } from "@gctp/shared";
import type { Caches } from "@gctp/shared";
import { CachesService } from "../caches/caches.service.js";
import { CachesRepository } from "../caches/caches.repository.js";
import { CacheLanduseRepository } from "../caches/cache-landuse.repository.js";
import { RoutingRepository } from "../routing/routing.repository.js";
import { RoutingService } from "../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../routing/osrm.client.js";
import { OsrmVersionService } from "../routing/osrm-version.service.js";
import { AdventureLabEnricher } from "../sources/adventure-lab/al-enricher.service.js";
import { GREEDY_PLANNER, SOLVER_PLANNER } from "./planner.tokens.js";
import { haversineMeters } from "./strategies/greedy/equirectangular.js";
import { explainSelection } from "./strategies/greedy/clustering/explain.js";
import {
  buildWalkingGraphResponse,
  purgeBogusWalkingCells,
  testOsrmRoute,
  viaRoute,
} from "./strategies/greedy/clustering/walking-graph-debug.js";

const PREFETCH_PROFILE = "foot" as const;
/** Top-N clusters whose intra-cluster pairs we warm after Pass 1. */
const PREFETCH_TOP_N = 5;

/** Cluster-augment (FR-I15): metres added beyond the cluster's own extent. */
const AUGMENT_BUFFER_M = 500;
/** Cluster-augment: adventures to fetch from Lab2Gpx — small + fast by design. */
const AUGMENT_LIMIT_ADVENTURES = 25;
/** Hard cap on the augmented id set (mirrors the planner's MAX_LOOP_CACHES). */
const AUGMENT_MAX_CACHES = 50;

@Injectable()
export class ToursService {
  private readonly logger = new Logger(ToursService.name);

  constructor(
    @Inject(Tours.TOUR_PLANNER)
    private readonly planner: Tours.TourPlannerStrategy,
    @Inject(GREEDY_PLANNER)
    private readonly greedy: Tours.TourPlannerStrategy,
    @Inject(SOLVER_PLANNER)
    private readonly solver: Tours.TourPlannerStrategy,
    private readonly config: ConfigService,
    private readonly caches: CachesService,
    private readonly cachesRepo: CachesRepository,
    private readonly cacheLanduse: CacheLanduseRepository,
    private readonly routing: RoutingService,
    private readonly routingRepo: RoutingRepository,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    private readonly osrmVersion: OsrmVersionService,
    private readonly adventureLab: AdventureLabEnricher,
  ) {}

  async discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    // Clustering operates on the existing pool only — Adventure Lab stages
    // already in the DB participate like any other cache (the type filter
    // governs whether they're included). Fetching more labs is an explicit,
    // per-cluster action (`augmentClusterWithLabs`) and a manual admin bulk
    // import, never an inline whole-area fetch (too heavy — see FR-I15).
    const result = await this.planner.discoverClusters(ownerId, input);
    // Opportunistic warm-up: after Pass 1 returns, kick off /route fetches
    // for the intra-cluster pairs of the top-N candidates. The cells are
    // persisted to `route_legs` (source='route' + geometry), so Pass 2's
    // `getLeg` calls and the per-cluster polyline rendering both come from
    // cache. Fire-and-forget — failures must not poison the response.
    //
    // Deferred to a proper BullMQ `prefetch` queue when the M4 jobs runtime
    // lands (see docs/architecture/background-and-deploy.md). Inline is fine while we
    // run single-tenant; the work is bounded (~10×9/2 = 45 pairs × 5 = 225
    // OSRM /route calls at the absolute worst).
    this.prefetchClusterLegs(ownerId, result.candidates).catch((err) => {
      this.logger.warn(
        `prefetch-cluster-legs failed: ${(err as Error).message}`,
      );
    });
    return result;
  }

  /**
   * Pass-2 routing. Strategy is chosen **per request** (FR-I16): the Timefold
   * solver when Adventure Labs are in the candidate set (it models atomic
   * adventures + budget + loop shape), the greedy planner otherwise (fast path).
   * `TOUR_PLANNER` env overrides: `auto` (default) | `greedy` | `solver`. The
   * solver is best-effort — if the sidecar is down/times out we fall back to
   * greedy so an AL plan still returns.
   */
  async planLoop(
    ownerId: string,
    input: Tours.PlanLoopInput,
  ): Promise<Tours.PlanResult> {
    // Default `auto` (FR-I16): the solver path now has co-location collapse,
    // atomic-adventure + contiguity constraints, and a lexicographic loop-shape
    // objective, so AL plans route to Timefold while cache-only plans stay on the
    // fast greedy path. Override with TOUR_PLANNER=greedy (force fast path) or
    // =solver (force the solver for every plan).
    const mode = (this.config.get<string>("TOUR_PLANNER") ?? "auto").trim();
    let useSolver: boolean;
    if (mode === "solver") useSolver = true;
    else if (mode === "greedy") useSolver = false;
    else {
      // auto: solver only when the candidate set contains Adventure Lab stages.
      const rows = await this.cachesRepo.findByIds(ownerId, input.cacheIds);
      useSolver = rows.some((c) => c.type === "Adventure Lab");
    }

    if (!useSolver) return this.greedy.planLoop(ownerId, input);

    // Pull in any missing stages of adventures already in the selection so the
    // solver can keep them complete (FR-I16). Atomicity itself is enforced in the
    // solver's constraints. Adventures that won't fit the candidate cap are
    // skipped whole — their stage ids come back as `cappedStageIds` so we can
    // surface them as `candidate-cap` drops rather than letting them vanish.
    const { cacheIds, cappedStageIds } = await this.expandForCompleteAdventures(
      ownerId,
      input.cacheIds,
    );
    const solverInput: Tours.PlanLoopInput = { ...input, cacheIds };
    let result: Tours.PlanResult;
    try {
      result = await this.solver.planLoop(ownerId, solverInput);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        this.logger.warn(
          `Solver unavailable (${err.message}); falling back to greedy for this plan.`,
        );
        result = await this.greedy.planLoop(ownerId, solverInput);
      } else {
        throw err;
      }
    }
    return this.withCandidateCapDrops(result, cappedStageIds);
  }

  /**
   * Append the adventure stages that never reached the planner (skipped whole
   * because they'd overflow the candidate cap) to a plan result as
   * `candidate-cap` drops. Additive + back-compat: a result without
   * `droppedCaches` (shouldn't happen post-FR) still merges cleanly. Keeps
   * `droppedCacheIds` and `droppedCaches` in lock-step.
   */
  private withCandidateCapDrops(
    result: Tours.PlanResult,
    cappedStageIds: readonly number[],
  ): Tours.PlanResult {
    if (cappedStageIds.length === 0) return result;
    const droppedCacheIds = result.droppedCacheIds ?? [];
    const droppedCaches = result.droppedCaches ?? [];
    const already = new Set(droppedCacheIds);
    const fresh = cappedStageIds.filter((id) => !already.has(id));
    if (fresh.length === 0) return result;
    return {
      ...result,
      droppedCacheIds: [...droppedCacheIds, ...fresh],
      droppedCaches: [
        ...droppedCaches,
        ...fresh.map((id) => ({ id, reason: "candidate-cap" as const })),
      ],
    };
  }

  /**
   * Expand a cluster's cache ids with the missing stages of any Adventure Lab it
   * already touches, so the solver can complete adventures. Adventures are added
   * **whole** (never split) up to the candidate cap; non-AL caches are always
   * kept. Returns the original ids unchanged when no AL is present.
   */
  private async expandForCompleteAdventures(
    ownerId: string,
    cacheIds: readonly number[],
  ): Promise<{ cacheIds: number[]; cappedStageIds: number[] }> {
    const rows = await this.cachesRepo.findByIds(ownerId, cacheIds);
    const adventureIds = [
      ...new Set(
        rows
          .map((r) => r.adventureId)
          .filter((x): x is string => x != null && x.length > 0),
      ),
    ];
    if (adventureIds.length === 0)
      return { cacheIds: [...new Set(cacheIds)], cappedStageIds: [] };

    const stages = await this.cachesRepo.findAdventureStages(
      ownerId,
      adventureIds,
    );
    const byAdventure = new Map<string, number[]>();
    for (const s of stages) {
      if (s.adventureId == null) continue;
      const arr = byAdventure.get(s.adventureId) ?? [];
      arr.push(s.id);
      byAdventure.set(s.adventureId, arr);
    }

    // Non-AL caches from the original selection are always kept.
    const result = new Set<number>(
      rows.filter((r) => r.adventureId == null).map((r) => r.id),
    );
    // Stages of adventures skipped at the cap — surfaced as `candidate-cap`.
    const cappedStageIds: number[] = [];
    for (const ids of byAdventure.values()) {
      if (result.size + ids.length > AUGMENT_MAX_CACHES) {
        // whole-or-none: skip an adventure that won't fit the cap
        cappedStageIds.push(...ids);
        continue;
      }
      for (const id of ids) result.add(id);
    }
    if (cappedStageIds.length > 0) {
      this.logger.debug(
        `expandForCompleteAdventures: candidate cap ${AUGMENT_MAX_CACHES} skipped ${cappedStageIds.length} stage(s) across whole adventure(s)`,
      );
    }
    return { cacheIds: [...result], cappedStageIds };
  }

  /**
   * FR-I15 cluster augmentation: pull nearby Adventure Lab stages into a chosen
   * cluster. Does a *small* Lab2Gpx fetch around the cluster's own extent
   * (+buffer), imports the stages via the GPX path, then returns the cluster's
   * ids expanded with nearby labs (existing + freshly imported), nearest-first,
   * capped at the loop max. No-op (returns the input unchanged) when the admin
   * flag is off. Best-effort: a Lab2Gpx failure still returns whatever labs are
   * already local, never throws.
   */
  async augmentClusterWithLabs(
    ownerId: string,
    input: Tours.AugmentClusterInput,
  ): Promise<Tours.AugmentClusterResult> {
    const cacheIds = Array.from(new Set(input.cacheIds));
    if (!this.adventureLab.enabled) return { cacheIds, added: 0 };

    const rows = await this.cachesRepo.findByIds(ownerId, cacheIds);
    if (rows.length === 0) return { cacheIds, added: 0 };

    const coords = rows.map((c) => c.location.coordinates as [number, number]);
    const centroid: [number, number] = [
      coords.reduce((s, c) => s + c[0], 0) / coords.length,
      coords.reduce((s, c) => s + c[1], 0) / coords.length,
    ];
    const clusterRadiusM = coords.reduce(
      (max, c) => Math.max(max, haversineMeters(centroid, c)),
      0,
    );
    const fetchRadiusM = Math.round(clusterRadiusM) + AUGMENT_BUFFER_M;

    // Import nearby labs (best-effort — null on flag-off/outage); we then read
    // them back from the DB alongside any that were already local.
    await this.adventureLab.enrich(
      ownerId,
      { center: centroid, radiusM: fetchRadiusM },
      { limitAdventures: AUGMENT_LIMIT_ADVENTURES },
    );

    const nearby = await this.cachesRepo.find({
      ownerId,
      center: centroid,
      radiusM: fetchRadiusM,
      types: ["Adventure Lab"],
      excludeFound: true,
    });

    const have = new Set(cacheIds);
    const labsByDistance = nearby
      .filter((c) => !have.has(c.id))
      .map((c) => ({
        id: c.id,
        d: haversineMeters(
          centroid,
          c.location.coordinates as [number, number],
        ),
      }))
      .sort((a, b) => a.d - b.d);

    const room = Math.max(0, AUGMENT_MAX_CACHES - cacheIds.length);
    const addedIds = labsByDistance.slice(0, room).map((l) => l.id);
    return { cacheIds: [...cacheIds, ...addedIds], added: addedIds.length };
  }

  /**
   * For each distinct parking waypoint contributed by the supplied cluster,
   * return an OSRM-routed walk to the cluster's nearest cache. Powers the
   * web map's parking-preview layer so the user can compare candidate
   * parking spots before committing to a plan.
   *
   * Costs one OSRM /route per unique parking; capped at `maxOptions` (≤20)
   * so a cluster with many parkings can't fan out unboundedly. Results
   * sorted by walking distance ascending.
   */
  async getParkingOptions(
    ownerId: string,
    input: Tours.ParkingOptionsInput,
  ): Promise<Tours.ParkingOptionsResponse> {
    const caches = await this.cachesRepo.findByIds(ownerId, input.cacheIds);
    if (caches.length === 0) return { options: [] };

    // Deduplicate parking waypoints by rounded coord — the same physical
    // spot is often listed by multiple caches in a cluster.
    const byKey = new Map<
      string,
      { lng: number; lat: number; ownerCacheId: number }
    >();
    for (const c of caches) {
      for (const [lng, lat] of c.parkingPoints) {
        const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
        if (!byKey.has(key)) {
          byKey.set(key, { lng, lat, ownerCacheId: c.id });
        }
      }
    }
    if (byKey.size === 0) return { options: [] };

    // Bundle the "which cache is each parking nearest to (by walking)"
    // question into ONE OSRM /table call covering all parkings × all
    // caches. Previous shape did N parkings × routeAlternatives = N
    // separate OSRM /route requests; for a cluster with 12 parkings
    // that's 11 calls we can skip.
    const parkings = Array.from(byKey.entries()).map(([key, p]) => ({
      key,
      parking: p,
    }));
    const parkingCoords: [number, number][] = parkings.map((p) => [
      p.parking.lng,
      p.parking.lat,
    ]);
    const cacheCoords: [number, number][] = caches.map(
      (c) => c.location.coordinates as [number, number],
    );
    // /table returns an (origins × destinations) matrix. We pass
    // [...parkings, ...caches] and read the parkings-rows × caches-cols
    // submatrix.
    const matrix = await this.osrm.table(
      [...parkingCoords, ...cacheCoords],
      "foot",
    );

    // First pass: pick each parking's nearest *walking* cache (not
    // haversine) and capture meters + seconds.
    interface Picked {
      key: string;
      parking: { lng: number; lat: number; ownerCacheId: number };
      nearestCache: Caches.CacheDTO;
      walkingMeters: number;
      walkingSeconds: number;
    }
    const picked: Picked[] = [];
    for (let i = 0; i < parkings.length; i += 1) {
      const row = matrix[i];
      if (!row) continue;
      let bestJ = -1;
      let bestM = Number.POSITIVE_INFINITY;
      let bestS = 0;
      for (let j = 0; j < caches.length; j += 1) {
        const cell = row[parkings.length + j];
        if (!cell) continue;
        if (cell.meters < bestM) {
          bestM = cell.meters;
          bestS = cell.seconds;
          bestJ = j;
        }
      }
      if (bestJ < 0) continue;
      picked.push({
        key: parkings[i]!.key,
        parking: parkings[i]!.parking,
        nearestCache: caches[bestJ]!,
        walkingMeters: bestM,
        walkingSeconds: bestS,
      });
    }

    // Sort non-bogus first (by walking meters asc), then bogus (also
    // asc). Truncate to `maxOptions` BEFORE fetching geometries — we
    // only need polylines for what we'll actually render.
    const withBogus = picked.map((p) => ({
      ...p,
      bogus:
        input.maxWalkingMeters !== undefined &&
        p.walkingMeters > input.maxWalkingMeters,
    }));
    withBogus.sort((a, b) => {
      if (a.bogus !== b.bogus) return a.bogus ? 1 : -1;
      return a.walkingMeters - b.walkingMeters;
    });
    const survivors = withBogus.slice(0, input.maxOptions);

    // Second pass: ONE /route per survivor for the polyline. Could be
    // collapsed further into a routeAlternatives if the primary tends
    // to be a detour (it sometimes is, per ADR-0011 comments), but
    // this already drops from N OSRM calls per cluster preview to
    // ~maxOptions + 1.
    const options: Tours.ParkingOption[] = [];
    for (const p of survivors) {
      const route = await this.osrm.route(
        [p.parking.lng, p.parking.lat],
        p.nearestCache.location.coordinates as [number, number],
        "foot",
      );
      if (!route) continue;
      options.push({
        id: p.key,
        point: [p.parking.lng, p.parking.lat],
        ownerCacheId: p.parking.ownerCacheId,
        nearestCacheId: p.nearestCache.id,
        walkingMeters: p.walkingMeters,
        walkingSeconds: p.walkingSeconds,
        polyline: route.geometry,
        bogus: p.bogus,
      });
    }
    return { options };
  }

  /**
   * Best-effort: ensure every intra-cluster cache pair in the top-N candidates
   * has a cached /route leg. Uses RoutingService.getLeg which already
   * deduplicates against the existing cache, so re-running this on the same
   * input is cheap. Bounded concurrency keeps it from competing with the
   * planner thread for OSRM bandwidth.
   */
  private async prefetchClusterLegs(
    ownerId: string,
    candidates: readonly Tours.ClusterCandidate[],
  ): Promise<void> {
    const top = candidates.slice(0, PREFETCH_TOP_N);
    if (top.length === 0) return;
    const pairs: { from: number; to: number }[] = [];
    const seen = new Set<string>();
    for (const c of top) {
      const ids = c.cacheIds;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = 0; j < ids.length; j += 1) {
          if (i === j) continue;
          const from = ids[i]!;
          const to = ids[j]!;
          const key = `${from}:${to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push({ from, to });
        }
      }
    }
    if (pairs.length === 0) return;
    const CONCURRENCY = 4;
    let warmed = 0;
    for (let i = 0; i < pairs.length; i += CONCURRENCY) {
      const slice = pairs.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (p) => {
          try {
            const leg = await this.routing.getLeg(
              ownerId,
              p.from,
              p.to,
              PREFETCH_PROFILE,
            );
            if (leg) warmed += 1;
          } catch {
            // Swallow per-pair failures — one bad pair shouldn't stop the
            // rest of the warm-up. Errors are already logged inside the
            // routing service / OSRM client.
          }
        }),
      );
    }
    this.logger.debug(
      `prefetch-cluster-legs: warmed ${warmed}/${pairs.length} pairs across ${top.length} clusters`,
    );
  }

  /**
   * Diagnose an arbitrary cache selection. Analytic and strategy-agnostic —
   * doesn't go through the TourPlannerStrategy because it runs ALL strategies
   * on the same context for comparison.
   */
  explainSelection(
    ownerId: string,
    input: Tours.ExplainClusterInput,
  ): Promise<Tours.ExplainClusterResponse> {
    return explainSelection(ownerId, input, {
      caches: this.caches,
      cachesRepo: this.cachesRepo,
      cacheLanduse: this.cacheLanduse,
      routingRepo: this.routingRepo,
      osrm: this.osrm,
      osrmVersion: this.osrmVersion,
    });
  }

  /** Debug: full sparse walking graph for the area, ready for map rendering. */
  walkingGraph(
    ownerId: string,
    input: Tours.WalkingGraphInput,
  ): Promise<Tours.WalkingGraphResponse> {
    return buildWalkingGraphResponse(ownerId, input, {
      caches: this.caches,
      cachesRepo: this.cachesRepo,
      cacheLanduse: this.cacheLanduse,
      routingRepo: this.routingRepo,
      osrm: this.osrm,
      osrmVersion: this.osrmVersion,
    });
  }

  /**
   * Destructive: drop stale `route_legs` rows whose stored walking distance
   * is suspiciously zero for the caches in the search area. After this, the
   * next planner pass refetches from OSRM.
   */
  purgeBogusWalkingCells(
    ownerId: string,
    input: Tours.PurgeBogusInput,
  ): Promise<Tours.PurgeBogusResponse> {
    return purgeBogusWalkingCells(ownerId, input, {
      caches: this.caches,
      routingRepo: this.routingRepo,
      osrmVersion: this.osrmVersion,
    });
  }

  /** Live OSRM /route for a single pair — bypasses route_legs cache entirely. */
  testOsrmRoute(
    ownerId: string,
    input: Tours.TestRouteInput,
  ): Promise<Tours.TestRouteResponse> {
    return testOsrmRoute(ownerId, input, {
      caches: this.caches,
      osrm: this.osrm,
    });
  }

  /**
   * Live OSRM `from → via → to` foot-route — powers the draggable
   * via-point edit UI. Bypasses `route_legs` (every drag position is
   * unique). Throttling is the client's responsibility.
   */
  viaRoute(
    ownerId: string,
    input: Tours.ViaRouteInput,
  ): Promise<Tours.ViaRouteResponse> {
    return viaRoute(ownerId, input, {
      caches: this.caches,
      osrm: this.osrm,
    });
  }
}
