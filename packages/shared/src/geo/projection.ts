// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Single local equirectangular projection for one tour-planning request.
 *
 * Every cache in a request lives inside a search circle of at most
 * `radiusM ≤ 50_000` (see `PlanInput`), so every point is ≤ 50 km from the
 * circle centre. Anchoring a single flat projection at that centre keeps the
 * deviation from true great-circle distance under ~0.3% even for a pair at the
 * very edge of the circle (the residual is the cos(lat) drift away from the
 * reference latitude; curvature itself contributes < 0.01%), and far smaller
 * for the short, nearby-cache legs that actually drive clustering and TSP.
 * That is dwarfed by the ~30-40% haversine→walking inflation the planner
 * already applies — so we project once, relative to the request centre, and do
 * every downstream distance as a plain Euclidean `hypot` in metres. No per-pair
 * `sin`/`cos`/`atan2`.
 *
 * The metres-per-degree scale factors come from the FCC §73.208 polynomials,
 * which fit WGS84 to a few cm/deg across our latitudes — strictly better than
 * the flat `111_320 m/deg + cos(lat)` approximation they replace — and, like
 * everything here, are evaluated ONCE from the reference latitude.
 *
 * Pure and structured-clone-free, so it is safe to build inside the planner
 * worker (ADR-0014) and share across the clustering pipeline.
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * Metres per degree of latitude at latitude `lat` (degrees). FCC §73.208.
 * ~111 km, varying ~1 km pole-to-equator due to the ellipsoid.
 */
export function metersPerDegreeLat(lat: number): number {
  const phi = lat * DEG_TO_RAD;
  return 111_132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
}

/**
 * Metres per degree of longitude at latitude `lat` (degrees). FCC §73.208.
 * Shrinks with `cos(lat)` from ~111 km at the equator to 0 at the poles.
 */
export function metersPerDegreeLng(lat: number): number {
  const phi = lat * DEG_TO_RAD;
  return (
    111_412.84 * Math.cos(phi) -
    93.5 * Math.cos(3 * phi) +
    0.118 * Math.cos(5 * phi)
  );
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

/**
 * A request-scoped projection. Build it once with `makeProjection` at the
 * search-circle centre; reuse it for every distance in the request.
 */
export interface Projection {
  readonly refLng: number;
  readonly refLat: number;
  /** Metres per degree latitude / longitude at the reference latitude. */
  readonly metersPerDegLat: number;
  readonly metersPerDegLng: number;
  /** Project `[lng, lat]` to planar metres relative to the reference point. */
  project(lng: number, lat: number): ProjectedPoint;
  /** Straight-line metres between two `[lng, lat]` points. */
  distanceMeters(
    a: readonly [number, number],
    b: readonly [number, number],
  ): number;
}

/**
 * Build a projection anchored at `(refLng, refLat)` — pass the request's search
 * circle centre. The latitude-dependent scale factors are computed here, once.
 */
export function makeProjection(refLng: number, refLat: number): Projection {
  const metersPerDegLat = metersPerDegreeLat(refLat);
  const metersPerDegLng = metersPerDegreeLng(refLat);
  return {
    refLng,
    refLat,
    metersPerDegLat,
    metersPerDegLng,
    project(lng, lat) {
      return {
        x: (lng - refLng) * metersPerDegLng,
        y: (lat - refLat) * metersPerDegLat,
      };
    },
    distanceMeters(a, b) {
      // The reference offset cancels, so this is independent of the anchor:
      // hypot of the per-axis degree deltas scaled to metres.
      const dx = (b[0] - a[0]) * metersPerDegLng;
      const dy = (b[1] - a[1]) * metersPerDegLat;
      return Math.hypot(dx, dy);
    },
  };
}
