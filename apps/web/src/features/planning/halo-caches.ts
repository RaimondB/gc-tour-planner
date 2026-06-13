// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CacheSummaryDTO } from "@gctp/shared/caches";
import { Tours } from "@gctp/shared";

/**
 * Boundary-halo caches (ADR-0026). Pass-1 discovery grows its candidate pool to
 * `clusterPoolRadiusMeters(radiusM, distanceBudgetMeters)` — past the search
 * `radiusM` — so an edge cluster can include members beyond the search circle.
 * The map's primary `/caches` query is radius-bounded, so those members would
 * have no marker (the cluster count says 10, the map draws 1). The web client
 * fetches a SECOND `/caches` page at the grown radius and unions it in, making
 * the visible set a superset of the clustered set.
 *
 * The grown radius comes from the SAME shared formula the API uses, so the two
 * sides cannot diverge. See `Tours.clusterPoolRadiusMeters`.
 */
export const haloRadiusMeters = Tours.clusterPoolRadiusMeters;

/**
 * Union two cache lists by `id`, keeping the first occurrence of each. Used to
 * merge the radius-bounded base set with the boundary halo so every cluster
 * member resolves to a coordinate. Returns `base` (or `halo`) unchanged when the
 * other is empty/undefined so callers keep a stable reference before discovery.
 */
export function mergeCachesById(
  base: readonly CacheSummaryDTO[] | undefined,
  halo: readonly CacheSummaryDTO[] | undefined,
): readonly CacheSummaryDTO[] | undefined {
  if (!halo || halo.length === 0) return base;
  if (!base || base.length === 0) return halo;
  const byId = new Map<number, CacheSummaryDTO>();
  for (const c of base) byId.set(c.id, c);
  for (const c of halo) if (!byId.has(c.id)) byId.set(c.id, c);
  return Array.from(byId.values());
}
