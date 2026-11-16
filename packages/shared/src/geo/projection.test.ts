// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  haversineMeters,
  makeProjection,
  metersPerDegreeLat,
  metersPerDegreeLng,
} from "./projection.js";

/** Reference haversine — the "truth" the projection approximates. */
function refHaversine(
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

describe("FCC metres-per-degree", () => {
  it("latitude scale stays ~111 km and grows toward the poles", () => {
    // WGS84: ~110.57 km/deg at the equator, ~111.69 km/deg at the pole.
    expect(metersPerDegreeLat(0)).toBeCloseTo(110_574, -2);
    expect(metersPerDegreeLat(90)).toBeCloseTo(111_694, -2);
    expect(metersPerDegreeLat(45)).toBeGreaterThan(metersPerDegreeLat(0));
  });

  it("longitude scale shrinks with cos(lat)", () => {
    expect(metersPerDegreeLng(0)).toBeCloseTo(111_320, -2);
    expect(metersPerDegreeLng(60)).toBeCloseTo(55_800, -2);
    expect(metersPerDegreeLng(90)).toBeCloseTo(0, -1);
  });
});

describe("makeProjection.distanceMeters", () => {
  // A few centres spanning the latitudes we actually plan in.
  const centres: ReadonlyArray<readonly [number, number]> = [
    [5.12, 52.09], // NL
    [-0.13, 51.51], // London
    [-122.42, 37.77], // SF
    [151.21, -33.87], // Sydney (southern hemisphere)
  ];

  /**
   * Ideal "per-pair" distance: same FCC datum, but with the longitude/latitude
   * scale taken at the pair's MIDPOINT latitude. Anchoring the real projection
   * at a single reference instead of re-deriving the scale per pair is the only
   * approximation the single-projection makes — comparing against this isolates
   * it from the (benign, constant) WGS84-vs-sphere datum offset.
   */
  function idealMeters(
    a: readonly [number, number],
    b: readonly [number, number],
  ): number {
    const midLat = (a[1] + b[1]) / 2;
    const dx = (b[0] - a[0]) * metersPerDegreeLng(midLat);
    const dy = (b[1] - a[1]) * metersPerDegreeLat(midLat);
    return Math.hypot(dx, dy);
  }

  for (const centre of centres) {
    const proj = makeProjection(centre[0], centre[1]);
    const mPerDegLng = metersPerDegreeLng(centre[1]);
    const mPerDegLat = metersPerDegreeLat(centre[1]);

    it(`stays within 0.3% of an ideal per-pair projection across the 50 km circle around [${centre.join(", ")}]`, () => {
      // Sweep pairs at the circle edge in 8 compass directions — the worst case
      // for cos-drift, since both points sit a full radius from the reference.
      for (let bearing = 0; bearing < 360; bearing += 45) {
        for (const distM of [250, 2_000, 25_000, 50_000]) {
          const rad = (bearing * Math.PI) / 180;
          const dLng = (distM * Math.sin(rad)) / mPerDegLng;
          const dLat = (distM * Math.cos(rad)) / mPerDegLat;
          const point: [number, number] = [centre[0] + dLng, centre[1] + dLat];
          const approx = proj.distanceMeters(centre, point);
          const ideal = idealMeters(centre, point);
          const relErr = Math.abs(approx - ideal) / Math.max(ideal, 1);
          // Far under the planner's ~1.4× walking inflation, so the
          // single-projection swap is numerically invisible.
          expect(relErr).toBeLessThan(0.003);
          // Short legs — the ones clustering/TSP lean on — are far tighter.
          if (distM <= 2_000) expect(relErr).toBeLessThan(0.0001);
        }
      }
    });
  }

  it("agrees with spherical haversine to within the WGS84 datum offset (~0.3%)", () => {
    // Sanity-check that we haven't drifted off Earth entirely: the flat FCC
    // distance and the legacy spherical haversine track each other to ~0.3%,
    // the constant ellipsoid-vs-sphere difference at our latitudes.
    const proj = makeProjection(5.12, 52.09);
    const a: [number, number] = [5.12, 52.09];
    const b: [number, number] = [5.4, 52.3];
    const relErr =
      Math.abs(proj.distanceMeters(a, b) - refHaversine(a, b)) /
      refHaversine(a, b);
    expect(relErr).toBeLessThan(0.003);
  });

  it("is symmetric and zero on coincident points", () => {
    const proj = makeProjection(5.12, 52.09);
    const a: [number, number] = [5.12, 52.09];
    const b: [number, number] = [5.3, 52.2];
    expect(proj.distanceMeters(a, a)).toBe(0);
    expect(proj.distanceMeters(a, b)).toBeCloseTo(proj.distanceMeters(b, a), 9);
  });

  it("project() round-trips the reference to the origin", () => {
    const proj = makeProjection(5.12, 52.09);
    expect(proj.project(5.12, 52.09)).toEqual({ x: 0, y: 0 });
  });
});

describe("haversineMeters", () => {
  it("is zero on coincident points and symmetric", () => {
    const a: [number, number] = [5.12, 52.09];
    const b: [number, number] = [4.9, 52.37];
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it("matches a known great-circle distance (Wageningen → Amsterdam ~68 km)", () => {
    const wageningen: [number, number] = [5.6633, 51.9692];
    const amsterdam: [number, number] = [4.9041, 52.3676];
    // ~68.1 km great-circle; allow ±500 m.
    expect(haversineMeters(wageningen, amsterdam)).toBeCloseTo(68_100, -3);
  });

  it("agrees with the equirectangular projection at local scale", () => {
    const a: [number, number] = [5.12, 52.09];
    const b: [number, number] = [5.18, 52.05];
    const proj = makeProjection(a[0], a[1]);
    const rel =
      Math.abs(haversineMeters(a, b) - proj.distanceMeters(a, b)) /
      haversineMeters(a, b);
    expect(rel).toBeLessThan(0.01); // <1% at a few km
  });
});
