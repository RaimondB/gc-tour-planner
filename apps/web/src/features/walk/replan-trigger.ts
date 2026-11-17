// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  metersBetween,
  type LngLat,
  type WalkSession,
} from "./walk-session.js";

/**
 * When should the walk ask the server for a new plan (FR-T18)? Events the user
 * caused (Found / DNF / Skip / Go here next / Replan) replan at once; the rest
 * — time drift, going off-plan — are automatic and debounced, so a jittery GPS
 * fix doesn't spam the (throttled) endpoint.
 */

/** Never replan automatically more often than this. */
export const MIN_AUTO_INTERVAL_MS = 20_000;
/** Refresh a plan this old so the times stay honest. */
export const DRIFT_INTERVAL_MS = 3 * 60_000;
/** Further than this from the planned path counts as off-plan … */
export const OFF_PLAN_M = 150;
/** … but only once the walker has also moved this far since the last plan. */
export const MOVED_M = 100;
/** Fixes worse than this don't move the plan. */
export const MAX_ACCURACY_M = 75;

export type ReplanReason = "no-plan" | "changed" | "drift" | "off-plan";

export function autoReplanReason(
  s: WalkSession,
  now: Date,
  position: LngLat | null,
  accuracyM: number | null,
  planPosition: LngLat | null,
): ReplanReason | null {
  if (!position || (accuracyM !== null && accuracyM > MAX_ACCURACY_M)) {
    return null;
  }
  if (!s.plan || !s.plannedAt) return "no-plan";
  // Logged or locked something the plan doesn't know yet (e.g. while offline).
  const plannedAt = s.plannedAt;
  if (
    s.log.some((l) => l.at > plannedAt) ||
    (s.lockedNextId !== null && s.plan.order[0]?.cacheId !== s.lockedNextId)
  ) {
    return "changed";
  }
  // Not at the start yet: the plan from the start point stands as it is.
  if (s.pendingStart) return null;
  const age = now.getTime() - Date.parse(s.plannedAt);
  if (age < MIN_AUTO_INTERVAL_MS) return null;
  if (age >= DRIFT_INTERVAL_MS) return "drift";
  const moved = planPosition ? metersBetween(planPosition, position) : 0;
  if (
    moved >= MOVED_M &&
    distanceToPath(position, s.plan.geometry?.coordinates) > OFF_PLAN_M
  ) {
    return "off-plan";
  }
  return null;
}

/** Shortest straight-line distance from `p` to a polyline (∞ without one). */
export function distanceToPath(
  p: LngLat,
  path: readonly (readonly number[])[] | undefined,
): number {
  if (!path || path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return metersBetween(p, path[0] as LngLat);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i += 1) {
    best = Math.min(
      best,
      pointToSegmentMeters(p, path[i - 1] as LngLat, path[i] as LngLat),
    );
  }
  return best;
}

/** Equirectangular projection around `p` — plenty accurate at walking scale. */
function pointToSegmentMeters(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const toXY = (q: LngLat): [number, number] => [
    (q[0] - p[0]) * 111_320 * k,
    (q[1] - p[1]) * 110_540,
  ];
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
