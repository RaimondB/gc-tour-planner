// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { solveLowOverlapLoop } from "./low-overlap-loop.js";
import { type DistanceMatrix, solveTwoOpt } from "./two-opt.js";

function matrixFromPoints(
  points: readonly (readonly [number, number])[],
): DistanceMatrix {
  return points.map((a) =>
    points.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])),
  );
}

const GRID = 25;

describe("solveLowOverlapLoop", () => {
  it("handles trivial cases", () => {
    expect(solveLowOverlapLoop([], 0, [], { beta: 1, gridMeters: GRID })).toEqual(
      { order: [], totalDistance: 0, retraceMeters: 0 },
    );
    expect(
      solveLowOverlapLoop([[0]], 0, [[5, 52]], { beta: 1, gridMeters: GRID }),
    ).toEqual({ order: [0], totalDistance: 0, retraceMeters: 0 });
  });

  it("matches solveTwoOpt exactly when beta = 0", () => {
    // Several Euclidean instances: with no overlap weight the low-overlap
    // solver must reduce to the proven shortest-distance solver.
    const instances: [number, number][][] = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [
        [0, 0],
        [3, 1],
        [1, 4],
        [4, 4],
        [2, 2],
        [5, 0],
      ],
    ];
    for (const pts of instances) {
      const d = matrixFromPoints(pts);
      const coords = pts.map(([x, y]) => [5 + x / 1000, 52 + y / 1000]) as [
        number,
        number,
      ][];
      const base = solveTwoOpt(d, 0);
      const low = solveLowOverlapLoop(d, 0, coords, { beta: 0, gridMeters: GRID });
      expect(low.order).toEqual(base.order);
      expect(low.totalDistance).toBeCloseTo(base.totalDistance, 6);
    }
  });

  it("trades a little distance to remove a crossing retrace", () => {
    // Rectangle corners (proxy coords). The distance matrix is deliberately
    // NON-Euclidean: it makes the *crossing* tour [0,1,3,2] cheapest, while the
    // perimeter [0,1,2,3] is longer but has no interior overlap. Shortest picks
    // the crossing; low-overlap should prefer the perimeter.
    const coords: [number, number][] = [
      [5.0, 52.0], // 0  SW
      [5.004, 52.0], // 1  SE
      [5.004, 52.004], // 2  NE
      [5.0, 52.004], // 3  NW
    ];
    // pairs: 01,02,03,12,13,23
    const d: DistanceMatrix = [
      [0, 1, 1, 2],
      [1, 0, 2, 1],
      [1, 2, 0, 1],
      [2, 1, 1, 0],
    ];

    const shortest = solveTwoOpt(d, 0);
    expect(shortest.order).toEqual([0, 1, 3, 2]); // crossing tour, length 4

    const zeroBeta = solveLowOverlapLoop(d, 0, coords, {
      beta: 0,
      gridMeters: GRID,
    });
    expect(zeroBeta.order).toEqual(shortest.order);

    const lowOverlap = solveLowOverlapLoop(d, 0, coords, {
      beta: 1000,
      gridMeters: GRID,
    });
    expect(lowOverlap.order).toEqual([0, 1, 2, 3]); // perimeter, no crossing
    // Less retracing than the distance-optimal crossing tour…
    expect(lowOverlap.retraceMeters).toBeLessThan(zeroBeta.retraceMeters);
    // …at the cost of a longer loop.
    expect(lowOverlap.totalDistance).toBeGreaterThan(zeroBeta.totalDistance);
  });

  it("is deterministic and returns a valid pinned Hamiltonian cycle", () => {
    const pts: [number, number][] = [
      [0, 0],
      [2, 1],
      [1, 3],
      [4, 2],
      [3, 0],
      [0, 4],
    ];
    const d = matrixFromPoints(pts);
    const coords = pts.map(([x, y]) => [5 + x / 1000, 52 + y / 1000]) as [
      number,
      number,
    ][];
    const a = solveLowOverlapLoop(d, 2, coords, { beta: 0.8, gridMeters: GRID });
    const b = solveLowOverlapLoop(d, 2, coords, { beta: 0.8, gridMeters: GRID });
    expect(a.order).toEqual(b.order);
    expect(a.order[0]).toBe(2); // start pinned
    expect([...a.order].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
