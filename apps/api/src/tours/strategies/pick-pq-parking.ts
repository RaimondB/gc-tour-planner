// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches } from "@gctp/shared";
import { Logger } from "@nestjs/common";
import type { OsrmClient } from "../../routing/osrm.client.js";

const logger = new Logger("pick-pq-parking");

/**
 * Pick the best Groundspeak Pocket Query parking waypoint for a cluster.
 *
 * Previously the picker just minimised haversine distance from cluster
 * centroid — fast but it can pick a parking on the wrong side of a
 * river / motorway / private land that's 50 m straight-line but 1.5 km
 * walking. Matching `pick-osm-parking`'s contract: OSRM-walk each
 * candidate to its nearest cluster cache and pick the shortest *walking*
 * distance. The PQ parking set is small (one or two per cache, often
 * shared across the cluster) so the N OSRM `/route` calls are cheap.
 *
 * Returns `null` when:
 *   - no parking waypoints exist in the cluster's caches, OR
 *   - every parking candidate fails OSRM `/route` (no walking path),
 *
 * in which case the caller falls back to OSRM-nearest centroid.
 */
export async function pickBestPqParking(
  cluster: readonly Caches.CacheDTO[],
  osrm: OsrmClient,
): Promise<[number, number] | null> {
  // Deduplicate parking points across the cluster's caches — the same
  // physical spot is often listed by multiple caches. Round to 5 dp
  // (~1 m) so floating-point noise doesn't produce phantom duplicates.
  // Sort by id first so the dedup is deterministic.
  const byKey = new Map<string, [number, number]>();
  const sorted = cluster.slice().sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    for (const p of c.parkingPoints) {
      const key = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
      if (!byKey.has(key)) byKey.set(key, [p[0], p[1]]);
    }
  }
  if (byKey.size === 0) return null;

  let best: [number, number] | null = null;
  let bestMeters = Number.POSITIVE_INFINITY;
  for (const parking of byKey.values()) {
    const nearest = nearestCacheTo(cluster, parking);
    const route = await osrm.route(
      parking,
      nearest.location.coordinates as [number, number],
      "foot",
    );
    if (!route) continue;
    if (route.meters < bestMeters) {
      bestMeters = route.meters;
      best = parking;
    }
  }

  if (best === null) {
    logger.debug(
      `${byKey.size} PQ parking candidate(s) but none OSRM-routable — falling back upstream`,
    );
    return null;
  }
  return best;
}

/** Pick the cluster cache with smallest equirectangular distance to `point`. */
function nearestCacheTo(
  cluster: readonly Caches.CacheDTO[],
  point: readonly [number, number],
): Caches.CacheDTO {
  let nearest = cluster[0]!;
  let nearestSq = Number.POSITIVE_INFINITY;
  for (const c of cluster) {
    const [lng, lat] = c.location.coordinates as [number, number];
    const dx = lng - point[0];
    const dy = lat - point[1];
    const sq = dx * dx + dy * dy;
    if (sq < nearestSq) {
      nearestSq = sq;
      nearest = c;
    }
  }
  return nearest;
}
