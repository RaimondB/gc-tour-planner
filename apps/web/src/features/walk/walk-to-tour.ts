// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PlanResult } from "@gctp/shared/tours";
import {
  metersBetween,
  type LngLat,
  type WalkSession,
} from "./walk-session.js";

/**
 * A finished walk as a normal saved tour (FR-T18): the caches actually visited
 * (found or DNF, in the order they happened), the walked GPS track as the
 * route, real distance / time. Built client-side — `POST /tours` accepts any
 * valid PlanResult. Null when nothing was visited.
 */
export function walkToPlanResult(
  s: WalkSession,
  endedAt: Date,
): PlanResult | null {
  const visited = s.log.filter((l) => l.outcome !== "skipped");
  if (visited.length === 0) return null;

  const stops = visited
    .map((l) => s.knownStops[l.cacheId]?.location)
    .filter((c): c is LngLat => c !== undefined);
  const walked: LngLat[] = s.track.map(([lng, lat]) => [lng, lat]);
  // Fall back to straight lines between stops when GPS recorded too little.
  const coordinates: LngLat[] =
    walked.length >= 2 ? walked : [s.startPoint, ...stops, s.returnPoint];
  let meters = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    meters += metersBetween(coordinates[i - 1]!, coordinates[i]!);
  }
  const visitMinutes = visited.reduce((sum, l) => {
    if (!l.arrivedAt) return sum;
    return sum + (Date.parse(l.at) - Date.parse(l.arrivedAt)) / 60_000;
  }, 0);

  return {
    orderedCacheIds: visited.map((l) => l.cacheId),
    droppedCacheIds: [],
    droppedCaches: [],
    polyline: { type: "LineString", coordinates },
    totals: {
      meters: Math.round(meters),
      seconds: Math.max(
        0,
        Math.round((endedAt.getTime() - Date.parse(s.startedAt)) / 1000),
      ),
      visitMinutes: Math.round(visitMinutes),
    },
    parking: {
      type: "user",
      point: { type: "Point", coordinates: s.startPoint },
      reason: "Ad-hoc walk start",
      fallback: false,
    },
    scoreBreakdown: {},
    legs: [],
  };
}
