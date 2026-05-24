// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Local equirectangular projection: lng/lat ⇒ planar (x, y) in meters
 * relative to a reference point. Accurate within ~1% over our search radii
 * (≤ 50 km) and far cheaper than haversine inside hot loops like DBSCAN's
 * region query.
 */

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface Equirectangular {
  project(lng: number, lat: number): ProjectedPoint;
}

const METERS_PER_DEG_LAT = 111_320;

export function makeEquirectangular(
  refLng: number,
  refLat: number,
): Equirectangular {
  const cosRef = Math.cos((refLat * Math.PI) / 180);
  return {
    project(lng, lat) {
      return {
        x: (lng - refLng) * METERS_PER_DEG_LAT * cosRef,
        y: (lat - refLat) * METERS_PER_DEG_LAT,
      };
    },
  };
}

export function distanceMeters(a: ProjectedPoint, b: ProjectedPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/**
 * Haversine on the sphere. Used at the API boundary where projection error
 * would dominate (e.g. inter-cluster distances or sanity-checking parking).
 */
export function haversineMeters(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
