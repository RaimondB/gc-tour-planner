// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Caches, Geo, Routing, Tours } from "@gctp/shared";
import { hasToolRequirement } from "@gctp/shared/caches";
import { CachesService } from "../../../caches/caches.service.js";
import { RoutingService } from "../../../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../../../routing/osrm.client.js";
import { ParkingFacilitiesRepository } from "../../../osm/parking-facilities.repository.js";
import { GreedyTspPlanner } from "../greedy/greedy-tsp-planner.js";
import { pickOsmParking } from "../pick-osm-parking.js";
import { pickBestPqParking } from "../pick-pq-parking.js";
import {
  OverlapGrid,
  pickAndAccumulate,
  readLoopOptionsFromEnv,
} from "../greedy/loop-aware-legs.js";
import {
  resolveMarginalTrimConfig,
  trimMarginalCaches,
} from "../greedy/marginal-trim.js";
import {
  SOLVER_CLIENT,
  type SolverClient,
  type SolverPlanRequest,
} from "./solver-client.js";

const PROFILE: Routing.RoutingProfile = "foot";
const MAX_LOOP_CACHES = 50;

/**
 * Solver-backed implementation of {@link Tours.TourPlannerStrategy}.
 *
 * **MVP boundary (intentional):** Pass 1 (cluster discovery) is delegated to
 * `GreedyTspPlanner` by composition. Only Pass 2 is solved by Timefold. The
 * follow-up wave will move cluster discovery behind a richer constraint
 * model — but discovery already runs on cheap aggregates (MST length, density,
 * parking presence), so there is no scoring lever the greedy version is
 * missing today. Pass 2 is where soft preferences (terrain, landuse, pace)
 * actually bite, which is why it's where Timefold lives first.
 *
 * Nest still owns:
 *   - OSRM matrix + per-leg geometry fetching
 *   - parking selection (reuses the same algorithm as greedy)
 *   - polyline stitching + ParkingChoice + scoreBreakdown construction
 *
 * The solver gets only what it needs: a precomputed numeric problem and a
 * weights object. It returns only orderedCacheIds + totals; Nest reassembles
 * the full PlanResult.
 */
@Injectable()
export class SolverTourPlanner implements Tours.TourPlannerStrategy {
  private readonly logger = new Logger(SolverTourPlanner.name);

  constructor(
    private readonly greedy: GreedyTspPlanner,
    private readonly caches: CachesService,
    private readonly routing: RoutingService,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    @Inject(SOLVER_CLIENT) private readonly solver: SolverClient,
    private readonly parkingFacilities: ParkingFacilitiesRepository,
  ) {}

  // ─── Pass 1: delegated to greedy ──────────────────────────────────────────

  discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    return this.greedy.discoverClusters(ownerId, input);
  }

  // ─── Pass 2: matrix → solver → geometry stitch ────────────────────────────

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

    // OD matrix (one OSRM /table call).
    const matrix = await this.routing.getMatrix(ownerId, ids, PROFILE);

    // Reject straight away if we have fewer than two reachable nodes — the
    // solver would happily return an empty visitOrder and we'd surface a
    // confusing 200 with no polyline.
    const reachableCount = ids
      .map((_, i) =>
        ids.some((_b, j) => i !== j && matrix.legs[i]?.[j] != null) ? 1 : 0,
      )
      .reduce<number>((a, b) => a + b, 0);
    if (reachableCount < 2) {
      throw new NotFoundException(
        "Selected caches are not mutually reachable on foot — pick a different cluster.",
      );
    }

    // Parking: same algorithm as greedy. Picked BEFORE the solver so the
    // anchor-to-parking legs go in as constants in the problem instance.
    const parking = await this.pickParking(input, cacheRows);
    const parkingCoord = parking.point.coordinates as [number, number];

    // Parking → cache and cache → parking legs (length N each).
    const parkingLegs = await Promise.all(
      ids.map((id) =>
        this.osrm.route(
          parkingCoord,
          byId.get(id)!.location.coordinates as [number, number],
          PROFILE,
        ),
      ),
    );
    const closingLegs = await Promise.all(
      ids.map((id) =>
        this.osrm.route(
          byId.get(id)!.location.coordinates as [number, number],
          parkingCoord,
          PROFILE,
        ),
      ),
    );

    // OSRM returns null for unreachable pairs; the solver needs concrete
    // numbers for the per-cache parking legs (otherwise it can't compute the
    // start/end totals). Force any unreachable cache to look extremely
    // expensive so the solver naturally drops it from the visit order.
    const PARK_UNREACHABLE_SENTINEL = 1e9;
    const parkingToCacheMeters = parkingLegs.map(
      (l) => l?.meters ?? PARK_UNREACHABLE_SENTINEL,
    );
    const parkingToCacheSeconds = parkingLegs.map(
      (l) => l?.seconds ?? PARK_UNREACHABLE_SENTINEL,
    );
    const cacheToParkingMeters = closingLegs.map(
      (l) => l?.meters ?? PARK_UNREACHABLE_SENTINEL,
    );
    const cacheToParkingSeconds = closingLegs.map(
      (l) => l?.seconds ?? PARK_UNREACHABLE_SENTINEL,
    );

    const visitSecondsPerCache = input.timePerCacheMinutes * 60;
    const timeBudgetSeconds = input.timeBudgetMinutes
      ? input.timeBudgetMinutes * 60
      : null;

    const req: SolverPlanRequest = {
      caches: ids.map((id) => ({
        id,
        lng: byId.get(id)!.location.coordinates[0]!,
        lat: byId.get(id)!.location.coordinates[1]!,
      })),
      matrixMeters: matrix.legs.map((row) =>
        row.map((cell) => (cell ? cell.meters : null)),
      ),
      matrixSeconds: matrix.legs.map((row) =>
        row.map((cell) => (cell ? cell.seconds : null)),
      ),
      parkingToCacheMeters,
      parkingToCacheSeconds,
      cacheToParkingMeters,
      cacheToParkingSeconds,
      distanceBudgetMeters: input.distanceBudgetMeters,
      timeBudgetSeconds,
      visitSecondsPerCache,
      weights: { visitedCount: 100 },
    };

    const response = await this.solver.plan(req);
    const solverOrderedIds = response.orderedCacheIds;
    if (solverOrderedIds.length === 0) {
      throw new NotFoundException(
        "Solver returned an empty tour — try a larger distance budget or a different cluster.",
      );
    }

    // Marginal-cost trim — same rationale as in GreedyTspPlanner. The
    // solver doesn't currently weight tour length (its only soft is
    // visitedCount), so it's especially likely to leave behind-barrier
    // caches in the tour. We use the matrix the solver was scored on
    // (built from primary-path /table distances) and re-TSP locally on
    // the surviving set.
    const trimDistances = matrix.legs.map((row) =>
      row.map((cell) => (cell ? cell.meters : null)),
    );
    // Threshold = user-supplied maxLinkMeters (see greedy-tsp-planner.ts
    // for the rationale). In budget-aware mode this is the legacy floor; the
    // distance budget + outlier factor drive the drops instead.
    const trimThreshold = input.maxLinkMeters;
    const trimCfg = resolveMarginalTrimConfig();
    // trimMarginalCaches is async (ADR-0014); the solver path uses its
    // synchronous fallback solve (its heavy work is the Timefold sidecar).
    const trim = await trimMarginalCaches({
      orderedIds: solverOrderedIds,
      originalIds: ids,
      distances: trimDistances,
      // Parking distances are already fetched per-cache (parkingLegs +
      // closingLegs), so endpoint trim is on — catches the
      // last-cache-stuck-behind-a-barrier case.
      parkingToCacheM: parkingToCacheMeters,
      cacheToParkingM: cacheToParkingMeters,
      thresholdMeters: trimThreshold,
      minRemaining: 2,
      // Budget-aware: route the full cluster, keep caches while the loop fits
      // the distance budget, trim only outliers / to fit budget.
      ...(trimCfg.budgetAware
        ? {
            budgetMeters: input.distanceBudgetMeters,
            outlierThresholdMeters: trimCfg.outlierFactor * trimThreshold,
          }
        : {}),
    });
    const orderedIds = trim.orderedIds;
    const droppedCacheIds = trim.droppedIds;
    if (droppedCacheIds.length > 0) {
      this.logger.debug(
        `marginal trim: dropped ${droppedCacheIds.length} cache(s) (~${Math.round(trim.savedMeters)} m saved, threshold=${Math.round(trimThreshold)} m): [${droppedCacheIds.join(", ")}]`,
      );
    }

    // Loop-aware polyline assembly. The solver was scored on primary-path
    // distances (the matrix we sent it), so its order is still correct, but
    // we render each leg using `pickAndAccumulate` against an OverlapGrid
    // so consecutive legs prefer non-overlapping streets when OSRM offers
    // alternatives. The picked legs' meters/seconds also feed back into
    // totals, so the displayed totals match the rendered polyline.
    const loopOpts = readLoopOptionsFromEnv();
    const grid = new OverlapGrid(loopOpts.picker.gridMeters);
    const altCount = loopOpts.altCount;
    const firstCoord = byId.get(orderedIds[0]!)!.location.coordinates as [
      number,
      number,
    ];
    const lastCoord = byId.get(orderedIds[orderedIds.length - 1]!)!.location
      .coordinates as [number, number];

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
          meters: picked.picked.meters,
          seconds: picked.picked.seconds,
          geometry: picked.picked.geometry,
        });
      }
    }

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
      parkingToFirst.picked.geometry,
      ...interCacheLegs.map((l) => l.geometry),
      lastToParking.picked.geometry,
    ]);

    const interMeters = sum(interCacheLegs.map((l) => l.meters));
    const interSeconds = sum(interCacheLegs.map((l) => l.seconds));
    const meters =
      parkingToFirst.picked.meters + interMeters + lastToParking.picked.meters;
    const seconds =
      parkingToFirst.picked.seconds +
      interSeconds +
      lastToParking.picked.seconds;
    // FR-SF7: match the greedy planner — add `toolBonusMinutes` per
    // cache that needs equipment. We keep the sidecar's flat
    // `visitSecondsPerCache` budget (line 151) for internal solver
    // optimisation; the bonus only shows up in the returned totals.
    // Effect on solver quality is small (~3-5% of typical tour time)
    // and the trade-off is documented in this comment.
    let toolStopCount = 0;
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (!c) continue;
      if (hasToolRequirement(c.attributeIds, c.descriptionHints))
        toolStopCount += 1;
    }
    const visitMinutes =
      input.timePerCacheMinutes * orderedIds.length +
      input.toolBonusMinutes * toolStopCount;

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
        solverTotalMeters: round2(response.totalMeters),
        solverTotalSeconds: round2(response.totalSeconds),
        tspLoopMeters: round2(meters),
        parkingDetourMeters: round2(
          parkingToFirst.picked.meters + lastToParking.picked.meters,
        ),
        budgetSlackMeters: round2(input.distanceBudgetMeters - meters),
        visitedCount: response.visitedCount,
        marginalTrimDroppedCount: droppedCacheIds.length,
        marginalTrimSavedMeters: round2(trim.savedMeters),
      },
      // Solver path doesn't expose per-leg alternatives — the sidecar
      // returns the final visit order, and Pass 2 here only fetches the
      // chosen route per leg. Edit-mode UI shows "no alternatives" for
      // solver-planned tours.
      legs: [],
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Parking selection. Mirrors GreedyTspPlanner.pickParking — kept private
   * here rather than promoted to a shared helper to keep the MVP diff small;
   * a follow-up can extract once the parking algorithm grows OSRM /nearest
   * snapping or multi-candidate scoring.
   */
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
          reason: "Manually picked start point",
          fallback: false,
        };
      }
      case "osrm-nearest-road":
        // Snap centroid to a real road via OSRM /nearest — otherwise a
        // centroid in a river / field becomes a huge parking-to-first detour.
        // This is the intended result for the mode, so it isn't a fallback
        // unless /nearest finds nothing at all.
        return this.snapCentroid(centroid, { snapIsFallback: false });
      case "osm-parking": {
        const osm = await pickOsmParking(
          this.parkingFacilities,
          this.osrm,
          input,
          cluster,
          centroid,
        );
        return (
          osm ??
          this.centroidFallback(
            centroid,
            "No public parking within range — starting at cluster centroid",
          )
        );
      }
      case "auto": {
        // First feasible source wins. The solver has no car-road enumerate, so
        // Auto's third step is the OSRM-nearest snap (which always resolves to
        // some point); the fallback only trips if even /nearest finds nothing.
        const best = await this.tryPqParking(cluster);
        if (best) return best;
        const osm = await pickOsmParking(
          this.parkingFacilities,
          this.osrm,
          input,
          cluster,
          centroid,
        );
        if (osm) return osm;
        return this.snapCentroid(centroid, { snapIsFallback: true });
      }
      case "parking-waypoint":
      default: {
        const best = await this.tryPqParking(cluster);
        return (
          best ??
          this.centroidFallback(
            centroid,
            "No cache-owner parking near this cluster — starting at cluster centroid",
          )
        );
      }
    }
  }

  /** Cache-owner (PQ) parking with the shortest walk to a cluster cache.
   *  `null` when none is OSRM-routable. */
  private async tryPqParking(
    cluster: readonly Caches.CacheDTO[],
  ): Promise<Tours.ParkingChoice | null> {
    const best = await pickBestPqParking(cluster, this.osrm);
    if (!best) return null;
    return {
      type: "pq",
      point: { type: "Point", coordinates: best },
      reason:
        "Cache-owner parking waypoint with shortest walking route to a cluster cache",
      fallback: false,
    };
  }

  /** Snap the centroid to the nearest walkable road. Used both as the explicit
   *  osrm-nearest-road mode (where a successful snap is the intended result) and
   *  as Auto's last resort (where it always counts as a fallback). A raw
   *  centroid — when /nearest finds no road — is always a fallback. */
  private async snapCentroid(
    centroid: [number, number],
    opts: { snapIsFallback: boolean },
  ): Promise<Tours.ParkingChoice> {
    const snapped = await this.osrm.nearest(centroid, PROFILE);
    return {
      type: "osrm-nearest",
      point: { type: "Point", coordinates: snapped ?? centroid },
      reason: snapped
        ? "Cluster centroid snapped to nearest walkable road"
        : "OSRM /nearest found no walkable road — using raw cluster centroid",
      fallback: snapped ? opts.snapIsFallback : true,
    };
  }

  /** Centroid fallback used when no parking source yields a feasible start. */
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
}

// ─── Pure utilities (mirrored from greedy; intentionally not deduped yet) ───

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

function haversineMeters(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
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
