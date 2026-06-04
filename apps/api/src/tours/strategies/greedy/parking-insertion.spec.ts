// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  bestParkingInsertion,
  rotateForBestParkingInsertion,
} from "./greedy-tsp-planner.js";

/**
 * Build the lookups `rotateForBestParkingInsertion` needs from plain maps.
 * Inter-cache distance is symmetric here (keyed by sorted pair).
 */
function lookups(
  parkingTo: Record<number, number>,
  toParking: Record<number, number>,
  edges: Record<string, number>,
) {
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  return {
    parkingToCacheAt: (id: number) => parkingTo[id] ?? Number.POSITIVE_INFINITY,
    cacheToParkingAt: (id: number) => toParking[id] ?? Number.POSITIVE_INFINITY,
    distAt: (a: number, b: number) =>
      a === b ? 0 : (edges[key(a, b)] ?? Number.POSITIVE_INFINITY),
  };
}

describe("bestParkingInsertion", () => {
  it("scores the cheapest edge and reports its start index", () => {
    // Cycle 1→2→3→4→1. Parking is close to 1 and 4, far from 2 and 3.
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      { 1: 20, 2: 800, 3: 850, 4: 30 },
      { 1: 20, 2: 800, 3: 850, 4: 30 },
      {
        "1-2": 100,
        "2-3": 100,
        "3-4": 100,
        "1-4": 100,
        "1-3": 100,
        "2-4": 100,
      },
    );
    // Best split is the 4→1 edge: in(20) + out(30) − skip(100) = −50, with 1
    // becoming first (start index 0 in this order).
    const { start, cost } = bestParkingInsertion(
      [1, 2, 3, 4],
      parkingToCacheAt,
      cacheToParkingAt,
      distAt,
    );
    expect(start).toBe(0);
    expect(cost).toBeCloseTo(-50);
  });

  it("returns Infinity cost when parking reaches nothing", () => {
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      {},
      {},
      { "1-2": 100, "2-3": 100, "1-3": 100 },
    );
    expect(
      bestParkingInsertion(
        [1, 2, 3],
        parkingToCacheAt,
        cacheToParkingAt,
        distAt,
      ).cost,
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("rotateForBestParkingInsertion", () => {
  it("leaves a single-cache cycle untouched", () => {
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      { 1: 10 },
      { 1: 10 },
      {},
    );
    expect(
      rotateForBestParkingInsertion(
        [1],
        parkingToCacheAt,
        cacheToParkingAt,
        distAt,
      ),
    ).toEqual([1]);
  });

  it("orients a 2-cache cycle so the shorter entry comes first", () => {
    // Parking is much closer to 2 than 1, so 2 should lead.
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      { 1: 500, 2: 20 },
      { 1: 30, 2: 600 },
      { "1-2": 100 },
    );
    // start at 1 (i=0): in p→1 (500) + out 2→p (600) − skip(100) = 1000.
    // start at 2 (i=1): in p→2 (20)  + out 1→p (30)  − skip(100) = −50. → wins.
    expect(
      rotateForBestParkingInsertion(
        [1, 2],
        parkingToCacheAt,
        cacheToParkingAt,
        distAt,
      ),
    ).toEqual([2, 1]);
  });

  it("rotates so parking splits the cheapest edge", () => {
    // Cycle 1→2→3→4→1. Parking sits right next to caches 1 and 4 (close),
    // far from 2 and 3. The cheapest split is the 4→1 edge, which keeps 1
    // first / 4 last — but only if the planner picks it. Set the seed order
    // so the *current* last→first edge (3→1) is expensive, forcing a rotation.
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      { 1: 20, 2: 800, 3: 850, 4: 30 },
      { 1: 20, 2: 800, 3: 850, 4: 30 },
      {
        "1-2": 100,
        "2-3": 100,
        "3-4": 100,
        "1-4": 100,
        "1-3": 100,
        "2-4": 100,
      },
    );
    // Seed order [1,2,3,4]: current behaviour splits the 4→1 edge already
    // (first=1, last=4) — both cheap. So a different seed is needed to prove
    // the rotation. Use [2,3,4,1]: current first=2 (800), last=1 (20).
    const rotated = rotateForBestParkingInsertion(
      [2, 3, 4, 1],
      parkingToCacheAt,
      cacheToParkingAt,
      distAt,
    );
    // Best split is between 4 and 1 (in=20, out=30) → first=1, last=4.
    expect(rotated[0]).toBe(1);
    expect(rotated[rotated.length - 1]).toBe(4);
    // Same cycle membership, just rotated.
    expect([...rotated].sort()).toEqual([1, 2, 3, 4]);
  });

  it("preserves the input order when the current split is already cheapest (ties to i=0)", () => {
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      { 1: 20, 2: 800, 3: 850, 4: 30 },
      { 1: 20, 2: 800, 3: 850, 4: 30 },
      {
        "1-2": 100,
        "2-3": 100,
        "3-4": 100,
        "1-4": 100,
        "1-3": 100,
        "2-4": 100,
      },
    );
    // first=1 (20), last=4 (30) is already the cheapest split → no rotation.
    expect(
      rotateForBestParkingInsertion(
        [1, 2, 3, 4],
        parkingToCacheAt,
        cacheToParkingAt,
        distAt,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("skips edges where parking can't reach an endpoint", () => {
    // Cache 3 is unreachable from parking (Infinity both ways). The rotation
    // must never choose a split that makes 3 the first or last cache.
    const { parkingToCacheAt, cacheToParkingAt, distAt } = lookups(
      { 1: 50, 2: 60, 3: Number.POSITIVE_INFINITY, 4: 40 },
      { 1: 50, 2: 60, 3: Number.POSITIVE_INFINITY, 4: 40 },
      {
        "1-2": 100,
        "2-3": 100,
        "3-4": 100,
        "1-4": 100,
        "1-3": 100,
        "2-4": 100,
      },
    );
    const rotated = rotateForBestParkingInsertion(
      [1, 2, 3, 4],
      parkingToCacheAt,
      cacheToParkingAt,
      distAt,
    );
    expect(rotated[0]).not.toBe(3);
    expect(rotated[rotated.length - 1]).not.toBe(3);
  });
});
