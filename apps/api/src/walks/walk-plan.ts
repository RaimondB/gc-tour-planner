// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Geo, type Caches, type RouteProfiles, type Walks } from "@gctp/shared";

/**
 * Pure pieces of the ad-hoc walk replan (ADR-0040): calibration clamps, the
 * per-cache prize, the candidate ellipse and the arrival schedule. Kept apart
 * from `WalksService` so they're unit-testable without OSRM or a database.
 */

export interface WalkPace {
  /** Seconds per metre walking out (calibrated). */
  outSecondsPerMeter: number;
  /** Seconds per metre on legs into the return point — never faster than the profile. */
  backSecondsPerMeter: number;
  /** Multiplier on planned visit time. */
  dwellFactor: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** ADR-0040 §4: calibrated pace out, profile pace (or slower) back. */
export function walkPace(
  profile: RouteProfiles.RouteProfileSettings,
  calibration: Walks.WalkCalibration,
): WalkPace {
  const profileMps = profile.time.walkingKmh / 3.6;
  const outMps = profileMps * clamp(calibration.paceFactor, 0.6, 1.5);
  const backMps = Math.min(outMps, profileMps);
  return {
    outSecondsPerMeter: 1 / outMps,
    backSecondsPerMeter: 1 / backMps,
    dwellFactor: clamp(calibration.dwellFactor, 0.5, 2),
  };
}

/**
 * ADR-0040 §2: `1 + preferredWeight·[preferred type] + landuseWeight·[in a
 * preferred landuse kind]`. Variety is applied on the set by the solver.
 */
export function cachePrize(
  cache: Pick<Caches.CacheDTO, "type">,
  landuseKinds: readonly string[],
  objective: RouteProfiles.RouteProfileSettings["objective"],
  preferredLanduseKinds: ReadonlySet<string>,
): number {
  const preferred = objective.preferredTypes.includes(cache.type)
    ? objective.preferredWeight
    : 0;
  const scenic = landuseKinds.some((k) => preferredLanduseKinds.has(k))
    ? objective.landuseWeight
    : 0;
  return 1 + preferred + scenic;
}

/**
 * Could the cache be visited at all? Straight-line S→c→E never exceeds the
 * walking distance, so anything outside this ellipse is out of reach —
 * and nothing reachable is wrongly excluded (ADR-0040 §3).
 */
export function insideReach(
  start: readonly [number, number],
  end: readonly [number, number],
  cache: readonly [number, number],
  maxMeters: number,
): boolean {
  return (
    Geo.haversineMeters(start, cache) + Geo.haversineMeters(cache, end) <=
    maxMeters
  );
}

/** Bounding circle of that ellipse, for the spatial pre-query. */
export function reachCircle(
  start: readonly [number, number],
  end: readonly [number, number],
  maxMeters: number,
): { center: [number, number]; radiusM: number } {
  return {
    center: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
    // Semi-major axis: every ellipse point is within it of the centre.
    radiusM: Math.max(1, maxMeters / 2),
  };
}

export interface ScheduleLeg {
  /** Travel seconds into this stop. */
  travelSeconds: number;
  visitSeconds: number;
  cacheId: number;
}

/** Arrival/leave times along the path, and the return. Times are epoch ms. */
export function schedule(
  startMs: number,
  legs: readonly ScheduleLeg[],
  backSeconds: number,
): { stops: Walks.WalkStop[]; returnMs: number; leaveLastMs: number } {
  let t = startMs;
  const stops: Walks.WalkStop[] = [];
  for (const leg of legs) {
    t += leg.travelSeconds * 1000;
    const arriveAt = new Date(t).toISOString();
    t += leg.visitSeconds * 1000;
    stops.push({
      cacheId: leg.cacheId,
      arriveAt,
      leaveAt: new Date(t).toISOString(),
    });
  }
  const leaveLastMs = t;
  return { stops, returnMs: t + backSeconds * 1000, leaveLastMs };
}
