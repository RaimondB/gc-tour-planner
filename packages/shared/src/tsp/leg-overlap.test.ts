// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  buildLegCellMap,
  OverlapAccumulator,
  pairIndex,
} from "./leg-overlap.js";

/** Total retrace penalty (m) of a set of legs, via a fresh accumulator. */
function overlapOf(
  coords: readonly (readonly [number, number])[],
  gridMeters: number,
  legs: readonly (readonly [number, number])[],
): number {
  const acc = new OverlapAccumulator(buildLegCellMap(coords, gridMeters));
  for (const [a, b] of legs) acc.add(a, b);
  return acc.penalty();
}

describe("pairIndex", () => {
  it("is order-independent and enumerates pairs uniquely", () => {
    const n = 5;
    const seen = new Set<number>();
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        expect(pairIndex(n, i, j)).toBe(pairIndex(n, j, i));
        seen.add(pairIndex(n, i, j));
      }
    }
    expect(seen.size).toBe((n * (n - 1)) / 2);
  });
});

describe("buildLegCellMap", () => {
  const coords: [number, number][] = [
    [5.0, 52.0],
    [5.01, 52.0],
    [5.02, 52.0],
    [5.0, 52.05],
  ];

  it("is deterministic", () => {
    const a = buildLegCellMap(coords, 25);
    const b = buildLegCellMap(coords, 25);
    expect([...a.offsets]).toEqual([...b.offsets]);
    expect([...a.cells]).toEqual([...b.cells]);
  });

  it("counts more overlap for collinear legs than a shared endpoint", () => {
    // 0,1,2 are collinear along lat=52. Leg 0→2 runs the whole corridor and
    // fully overlaps leg 0→1; legs 0→1 and 1→2 only meet at node 1's cell.
    const collinear = overlapOf(coords, 25, [
      [0, 2],
      [0, 1],
    ]);
    const sharedEndpoint = overlapOf(coords, 25, [
      [0, 1],
      [1, 2],
    ]);
    expect(collinear).toBeGreaterThan(sharedEndpoint);
  });

  it("counts near-zero overlap for legs running apart", () => {
    // Leg 0→1 (short, along lat=52) vs leg far away would share nothing; here
    // 0→1 vs 2→3 only barely interact, so overlap stays small.
    const apart = overlapOf(coords, 25, [
      [0, 1],
      [2, 3],
    ]);
    const collinear = overlapOf(coords, 25, [
      [0, 2],
      [0, 1],
    ]);
    expect(apart).toBeLessThan(collinear);
  });
});

describe("OverlapAccumulator.previewDelta", () => {
  const coords: [number, number][] = [
    [5.0, 52.0],
    [5.004, 52.0],
    [5.004, 52.004],
    [5.0, 52.004],
  ];

  it("matches a full recompute of the penalty change", () => {
    const map = buildLegCellMap(coords, 25);
    const acc = new OverlapAccumulator(map);
    // Seed a crossing pair of legs.
    acc.add(0, 1);
    acc.add(1, 3);
    acc.add(3, 2);
    acc.add(2, 0);
    const before = acc.penalty();

    // 2-opt-style move: remove (1,3),(2,0); add (1,2),(0,3).
    const removed: [number, number][] = [
      [1, 3],
      [2, 0],
    ];
    const added: [number, number][] = [
      [1, 2],
      [0, 3],
    ];
    const predicted = acc.previewDelta(removed, added);

    for (const [a, b] of removed) acc.remove(a, b);
    for (const [a, b] of added) acc.add(a, b);
    const actual = acc.penalty() - before;

    expect(predicted).toBeCloseTo(actual, 6);
  });
});
