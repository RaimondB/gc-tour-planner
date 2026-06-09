// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches, Tours } from "@gctp/shared";
import { Logger } from "@nestjs/common";
import type { OsrmClient } from "../../routing/osrm.client.js";
import { ParkingFacilitiesRepository } from "../../osm/parking-facilities.repository.js";

const logger = new Logger("pick-osm-parking");

/**
 * Pick a tour-start parking from `parking_facilities` (ADR-0011).
 *
 * Strategy:
 *   1. Pull every parking facility within `maxLinkMeters` of the cluster
 *      centroid, pre-filtered by the user's access + fee preferences.
 *   2. For each candidate, OSRM-walk from the facility centroid to the
 *      cluster's nearest cache (haversine fast-pick of which cache).
 *   3. Drop candidates whose walking distance exceeds `maxLinkMeters` —
 *      same bogus-route rule we apply in the parking preview layer.
 *   4. Return the survivor with the shortest walking distance.
 *
 * Returns `null` when no walkable OSM parking is reachable inside the
 * budget; the caller falls back to OSRM-nearest centroid.
 */
/** A parking facility candidate before any loop-aware scoring. */
export interface OsmParkingCandidate {
  point: [number, number];
  osmId: number;
  osmType: "N" | "W" | "R";
  access: string | null;
  fee: string | null;
  name: string | null;
}

/**
 * Enumerate *all* OSM parking facilities within `maxLinkMeters` of the cluster
 * centroid, pre-filtered by access + fee — no OSRM routing. Unlike
 * {@link pickOsmParking} (which walks each to its nearest cache and keeps the
 * shortest), this returns the raw candidate set so the caller can score every
 * one against the actual tour loop and pick the cheapest *insertion*, not just
 * the closest lot. Returns `[]` when nothing matches the filters in range.
 */
export async function enumerateOsmParking(
  repo: ParkingFacilitiesRepository,
  input: Tours.PlanLoopInput,
  centroid: [number, number],
): Promise<OsmParkingCandidate[]> {
  // Also used as Auto's OSM step (ADR-0011) — Auto enumerates the same way the
  // explicit `osm-parking` mode does, reusing the access/fee filter defaults.
  if (
    input.startPreference !== "osm-parking" &&
    input.startPreference !== "auto"
  )
    return [];
  const candidates = await repo.findNear(centroid, input.maxLinkMeters, {
    access: input.osmParkingAccessFilter as readonly string[],
    fee: input.osmParkingFeeFilter,
  });
  return candidates.map((c) => ({
    point: c.point,
    osmId: c.osmId,
    osmType: c.osmType,
    access: c.access,
    fee: c.fee,
    name: c.name,
  }));
}

export async function pickOsmParking(
  repo: ParkingFacilitiesRepository,
  osrm: OsrmClient,
  input: Tours.PlanLoopInput,
  cluster: readonly Caches.CacheDTO[],
  centroid: [number, number],
): Promise<Tours.ParkingChoice | null> {
  if (
    input.startPreference !== "osm-parking" &&
    input.startPreference !== "auto"
  )
    return null;

  const accessFilter = input.osmParkingAccessFilter as readonly string[];
  const feeFilter = input.osmParkingFeeFilter;

  const candidates = await repo.findNear(centroid, input.maxLinkMeters, {
    access: accessFilter,
    fee: feeFilter,
  });
  if (candidates.length === 0) {
    logger.debug(
      `no OSM parking candidates within ${input.maxLinkMeters}m of cluster centroid (${centroid[0]},${centroid[1]})`,
    );
    return null;
  }

  // Walk each candidate to its nearest cache; pick shortest walking
  // distance. Bounded by `findNear` which already filters by radius.
  let best: {
    osmId: number;
    osmType: "N" | "W" | "R";
    point: [number, number];
    access: string | null;
    fee: string | null;
    name: string | null;
    walkingMeters: number;
  } | null = null;

  for (const cand of candidates) {
    const nearest = nearestCache(cluster, cand.point);
    const route = await osrm.route(
      cand.point,
      nearest.location.coordinates as [number, number],
      "foot",
    );
    if (!route) continue;
    if (route.meters > input.maxLinkMeters) continue;
    if (!best || route.meters < best.walkingMeters) {
      best = { ...cand, walkingMeters: route.meters };
    }
  }

  if (!best) {
    logger.debug(
      `OSM parking candidates exist but none route within ${input.maxLinkMeters}m walking distance`,
    );
    return null;
  }

  const label = best.name ?? `osm-${best.osmType}/${best.osmId}`;
  return {
    type: "osm",
    point: { type: "Point", coordinates: best.point },
    reason: `OSM amenity=parking — ${label} (access=${best.access ?? "unknown"}, fee=${best.fee ?? "unknown"}, ~${Math.round(best.walkingMeters)}m walk)`,
    fallback: false,
    osm: {
      osmId: best.osmId,
      osmType: best.osmType,
      access: best.access,
      fee: best.fee,
      name: best.name,
    },
  };
}

function nearestCache(
  cluster: readonly Caches.CacheDTO[],
  point: [number, number],
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
