// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Boundary-spanning clusters (ADR-0026). When discovery fetches caches out to
// `radiusM + budget/2`, this partitions the result: the caches within the
// original search radius are the SEED set (clusters originate in the search
// area), and the whole fetched set — capped by proximity to the centre — is the
// candidate pool that clusters may grow into across the boundary.

import { haversineMeters } from "../equirectangular.js";

export interface GrowthPool<T> {
  /** Candidate pool, nearest-first, capped at `maxPool`. */
  pool: T[];
  /** Ids of pool members within the original search radius (the seed set). */
  inRadiusIds: Set<number>;
}

/**
 * Sort caches by distance to the search centre (so the in-radius set + nearest
 * halo survive the pool cap), keep the nearest `maxPool`, and mark which of
 * those fall within `radiusM` of the centre. Pure + deterministic (ties broken
 * by id).
 */
export function selectGrowthPool<
  T extends { id: number; location: { coordinates: readonly number[] } },
>(
  caches: readonly T[],
  center: readonly [number, number],
  radiusM: number,
  maxPool: number,
): GrowthPool<T> {
  const withDist = caches.map((c) => ({
    c,
    d: haversineMeters(
      [c.location.coordinates[0]!, c.location.coordinates[1]!],
      [center[0]!, center[1]!],
    ),
  }));
  withDist.sort((a, b) => a.d - b.d || a.c.id - b.c.id);
  const capped = withDist.slice(0, Math.max(0, maxPool));
  const pool = capped.map((x) => x.c);
  const inRadiusIds = new Set<number>();
  for (const x of capped) if (x.d <= radiusM) inRadiusIds.add(x.c.id);
  return { pool, inRadiusIds };
}
