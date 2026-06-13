// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Boundary-spanning cluster growth (ADR-0026), single-sourced.
 *
 * Pass-1 discovery enlarges its candidate pool beyond the search `radiusM` so a
 * cluster that straddles the search circle is fully detected instead of being
 * truncated at the boundary. The enlargement is `distanceBudgetMeters / 2` — the
 * farthest a cache can sit and still join a budget-valid loop anchored on an
 * in-radius seed.
 *
 * This margin is a CONTRACT shared by two codebases that must agree:
 *   - the API builds its pool at `clusterPoolRadiusMeters(...)` (see
 *     `prepareClusteringContext` in apps/api).
 *   - the web client must fetch caches out to the SAME radius, otherwise a grown
 *     cluster's halo members have no marker on the map (the count says 10, the
 *     map draws 1). See `apps/web/src/App.tsx`.
 *
 * Keeping the formula here means the two sides cannot silently diverge: change
 * the margin once, both follow, and `cluster-growth.spec.ts` pins it.
 */

/** Extra reach (metres) a budget-valid loop can extend past an in-radius seed. */
export function clusterGrowthMarginMeters(
  distanceBudgetMeters: number,
): number {
  if (!Number.isFinite(distanceBudgetMeters) || distanceBudgetMeters <= 0) {
    return 0;
  }
  return Math.floor(distanceBudgetMeters / 2);
}

/**
 * Effective radius (metres) the discovery candidate pool spans — the search
 * radius plus the growth margin. The web client fetches caches out to this
 * radius so its rendered set is a superset of the clustered set.
 */
export function clusterPoolRadiusMeters(
  radiusM: number,
  distanceBudgetMeters: number,
): number {
  return radiusM + clusterGrowthMarginMeters(distanceBudgetMeters);
}
