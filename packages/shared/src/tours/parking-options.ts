// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, LngLat } from "../geo/index.js";

/**
 * Input to `POST /tours/parking-options` — preview the walking paths from
 * each parking candidate near a cluster, so the user can compare options
 * before committing to a tour. Bounded to 50 cacheIds so an accidental
 * "all caches in the world" request can't blow up the OSRM /route fan-out.
 */
export const ParkingOptionsInput = z.object({
  cacheIds: z.array(z.number().int().positive()).min(1).max(50),
  /**
   * Cap on the number of distinct parking candidates returned. Returned
   * options are sorted by walking distance ascending; setting this limit
   * also bounds the number of OSRM /route calls (one per option).
   */
  maxOptions: z.number().int().positive().max(20).default(8),
});
export type ParkingOptionsInput = z.infer<typeof ParkingOptionsInput>;

export const ParkingOption = z.object({
  /**
   * Stable client-side key — a short hash of the rounded (lng, lat). Same
   * physical parking spot referenced by multiple caches collapses to one
   * entry here.
   */
  id: z.string(),
  point: LngLat,
  /** Cache id whose `parking` waypoint contributed this candidate. */
  ownerCacheId: z.number().int().positive(),
  /** Nearest cache (haversine) in the request's cluster. */
  nearestCacheId: z.number().int().positive(),
  walkingMeters: z.number().nonnegative(),
  walkingSeconds: z.number().nonnegative(),
  /** OSRM /route polyline from parking → nearestCache. */
  polyline: GeoJsonLineString,
});
export type ParkingOption = z.infer<typeof ParkingOption>;

export const ParkingOptionsResponse = z.object({
  options: z.array(ParkingOption),
});
export type ParkingOptionsResponse = z.infer<typeof ParkingOptionsResponse>;
