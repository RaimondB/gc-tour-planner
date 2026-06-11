// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { selectGrowthPool } from "./growth-pool.js";

// Caches strung north of the centre; each +0.001° lat ≈ 111 m, so distance
// from the centre grows monotonically with id here.
const CENTER: [number, number] = [5.0, 52.0];
const cache = (id: number, latOffset: number) => ({
  id,
  location: { coordinates: [5.0, 52.0 + latOffset] as [number, number] },
});
const caches = [
  cache(1, 0.001), // ~111 m
  cache(2, 0.002), // ~223 m
  cache(3, 0.003), // ~334 m
  cache(4, 0.004), // ~446 m
  cache(5, 0.005), // ~557 m
];

describe("selectGrowthPool", () => {
  it("partitions in-radius seeds from the grown halo", () => {
    const { pool, inRadiusIds } = selectGrowthPool(caches, CENTER, 300, 10);
    expect(pool.map((c) => c.id)).toEqual([1, 2, 3, 4, 5]); // nearest-first
    expect([...inRadiusIds].sort()).toEqual([1, 2]); // ≤ 300 m only
  });

  it("caps the pool by proximity, keeping the nearest (incl. all in-radius)", () => {
    const { pool, inRadiusIds } = selectGrowthPool(caches, CENTER, 300, 3);
    expect(pool.map((c) => c.id)).toEqual([1, 2, 3]);
    expect([...inRadiusIds].sort()).toEqual([1, 2]);
  });

  it("treats the whole fetch as in-radius when nothing was grown (grow off)", () => {
    // radiusM covers all → every pool member is seed-eligible (the grow=false
    // path, where the fetch radius equals the search radius).
    const { pool, inRadiusIds } = selectGrowthPool(caches, CENTER, 5000, 10);
    expect(pool).toHaveLength(5);
    expect(inRadiusIds.size).toBe(5);
  });

  it("breaks distance ties by id deterministically", () => {
    const tied = [cache(9, 0.002), cache(4, 0.002), cache(7, 0.002)];
    const { pool } = selectGrowthPool(tied, CENTER, 300, 10);
    expect(pool.map((c) => c.id)).toEqual([4, 7, 9]);
  });
});
