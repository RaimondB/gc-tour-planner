// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import { Tours } from "@gctp/shared";
import { CachesService } from "../caches/caches.service.js";
import { CachesRepository } from "../caches/caches.repository.js";
import { CacheLanduseRepository } from "../caches/cache-landuse.repository.js";
import { RoutingRepository } from "../routing/routing.repository.js";
import { RoutingService } from "../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../routing/osrm.client.js";
import { OsrmVersionService } from "../routing/osrm-version.service.js";
import { haversineMeters } from "./strategies/greedy/equirectangular.js";
import { explainSelection } from "./strategies/greedy/clustering/explain.js";
import {
  buildWalkingGraphResponse,
  purgeBogusWalkingCells,
  testOsrmRoute,
} from "./strategies/greedy/clustering/walking-graph-debug.js";

const PREFETCH_PROFILE = "foot" as const;
/** Top-N clusters whose intra-cluster pairs we warm after Pass 1. */
const PREFETCH_TOP_N = 5;

@Injectable()
export class ToursService {
  private readonly logger = new Logger(ToursService.name);

  constructor(
    @Inject(Tours.TOUR_PLANNER)
    private readonly planner: Tours.TourPlannerStrategy,
    private readonly caches: CachesService,
    private readonly cachesRepo: CachesRepository,
    private readonly cacheLanduse: CacheLanduseRepository,
    private readonly routing: RoutingService,
    private readonly routingRepo: RoutingRepository,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    private readonly osrmVersion: OsrmVersionService,
  ) {}

  async discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
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

  planLoop(
    ownerId: string,
    input: Tours.PlanLoopInput,
  ): Promise<Tours.PlanResult> {
    return this.planner.planLoop(ownerId, input);
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

    // For each parking, find the cluster's nearest cache by haversine
    // (cheap pre-filter — the OSRM /route then gives the real walking
    // distance to that cache). Then collect with bounded concurrency to
    // keep OSRM happy.
    const candidates = Array.from(byKey.entries()).map(([key, p]) => {
      let nearest = caches[0]!;
      let nearestD = Number.POSITIVE_INFINITY;
      for (const c of caches) {
        const d = haversineMeters(
          [p.lng, p.lat],
          c.location.coordinates as [number, number],
        );
        if (d < nearestD) {
          nearestD = d;
          nearest = c;
        }
      }
      return { key, parking: p, nearestCache: nearest };
    });

    const options: Tours.ParkingOption[] = [];
    for (const { key, parking, nearestCache } of candidates) {
      // Ask OSRM for up to 3 routes and pick the shortest by meters. The
      // primary `/route` result is sometimes a noticeable detour on dense
      // foot networks (e.g. it routes onto a main road instead of a
      // cut-through path); alternatives let us surface the genuinely
      // shortest walk to the user.
      const alts = await this.osrm.routeAlternatives(
        [parking.lng, parking.lat],
        nearestCache.location.coordinates as [number, number],
        "foot",
        3,
      );
      if (alts.length === 0) continue;
      const best = alts.reduce((a, b) => (a.meters <= b.meters ? a : b));
      // Flag options whose OSRM walk vastly exceeds the planner's link
      // budget — these are almost always OSM data gaps (missing footway
      // connectors, fenced-off shortcuts) rather than real walks. We keep
      // them in the response so the user can see "this parking belongs
      // to cache X but OSRM thinks it's far" and decide to file an OSM
      // fix; the client renders them in a warning style.
      const bogus =
        input.maxWalkingMeters !== undefined &&
        best.meters > input.maxWalkingMeters;
      options.push({
        id: key,
        point: [parking.lng, parking.lat],
        ownerCacheId: parking.ownerCacheId,
        nearestCacheId: nearestCache.id,
        walkingMeters: best.meters,
        walkingSeconds: best.seconds,
        polyline: best.geometry,
        bogus,
      });
    }
    // Sort non-bogus first (by walking meters asc), then bogus (also asc).
    // The maxOptions slice favours real candidates; bogus ones only appear
    // when there's still room.
    options.sort((a, b) => {
      if (a.bogus !== b.bogus) return a.bogus ? 1 : -1;
      return a.walkingMeters - b.walkingMeters;
    });
    return { options: options.slice(0, input.maxOptions) };
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
}
