// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hard data-quality guards applied at every point a /route or /table cell is
 * about to be written to `route_legs` (or kept for clustering). One file so
 * the thresholds — and their rationale — stay co-located.
 *
 * Existing soft thresholds (suspicious zero-distance) live in
 * `apps/api/src/tours/strategies/greedy/walking-graph.ts` because they
 * involve the *pair* of caches (need haversine of the cache coords), not
 * just the leg's own meters/seconds. The guards here only look at meters +
 * seconds and the optional haversine context, so they're safe to apply at
 * the persistence boundary.
 */

/**
 * Walking-speed bounds. < 1 km/h or > 28 km/h is almost certainly a bad
 * cell:
 *
 *  - 1 km/h (0.28 m/s): catches snap-to-same-node artefacts the
 *    `meters ≤ 5 ∧ haversine ≥ 50` zero-distance guard misses — e.g. a cell
 *    with meters=12, seconds=600 (slower than crawling).
 *  - 28 km/h (7.78 m/s): catches profile mis-tagging where car-speed
 *    weights leak into the foot profile, or stale rows from when an earlier
 *    extract briefly used a different profile.
 *
 * Both thresholds are well outside the "fast cyclist on a footpath" /
 * "elderly walker on a steep climb" range we still want to accept.
 */
export const MIN_WALKING_MS = 0.28;
export const MAX_WALKING_MS = 7.78;

/**
 * A walking leg that's > HIGH_DETOUR_REJECT× the haversine distance is
 * structurally wrong — OSM data gap, missing footway, fenced industrial
 * estate. Today's coverage warning (median ratio > 2.5, > 25 % at > 4) is
 * aggregate-only; this guard rejects the worst per-edge outliers so they
 * never feed back into Pass 1 clustering as if they were real walking legs.
 *
 * `HIGH_DETOUR_THRESHOLD = 4` in walking-graph-debug.ts is the *warn*
 * threshold (still useful for the coverage stat). 10× is the *reject*
 * threshold (almost certainly garbage).
 */
export const HIGH_DETOUR_REJECT = 10;

/**
 * Returns true if (meters, seconds) describes an impossible walking speed.
 * Zero-length legs are accepted as-is — the zero-distance guard upstream
 * handles the suspicious case where two distinct coords snapped together.
 */
export function isImpossibleSpeed(meters: number, seconds: number): boolean {
  if (!Number.isFinite(meters) || !Number.isFinite(seconds)) return true;
  if (meters <= 0) return false; // suspicious-zero guard handles these
  if (seconds <= 0) return true; // any non-zero distance must take time
  const ms = meters / seconds;
  return ms < MIN_WALKING_MS || ms > MAX_WALKING_MS;
}

/**
 * Returns true if the leg's walking/haversine ratio exceeds the reject
 * threshold. Pass `haversineM` only when you have both endpoint coords; the
 * walking-graph.ts builder always does, the per-pair `getLeg` does too,
 * `getMatrix` does. Returns false when haversine is too small to be
 * meaningful (the ratio gets noisy under a few metres).
 */
export function isImpossibleDetour(
  meters: number,
  haversineM: number,
): boolean {
  if (!Number.isFinite(meters) || !Number.isFinite(haversineM)) return true;
  if (haversineM < 10) return false; // ratio is meaningless at this scale
  return meters / haversineM > HIGH_DETOUR_REJECT;
}
