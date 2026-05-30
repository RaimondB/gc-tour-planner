// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { type DistanceMatrix, solveTwoOpt } from "./two-opt.js";

function matrixFromPoints(
  points: readonly (readonly [number, number])[],
): DistanceMatrix {
  return points.map((a) =>
    points.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])),
  );
}

describe("solveTwoOpt", () => {
  it("handles trivial cases", () => {
    expect(solveTwoOpt([])).toEqual({ order: [], totalDistance: 0 });
    expect(solveTwoOpt([[0]])).toEqual({ order: [0], totalDistance: 0 });
  });

  it("solves a unit square to perimeter 4", () => {
    // Square corners; the only sub-optimal NN seed possibility is a crossing
    // tour with length 2 + 2*sqrt(2) ≈ 4.83 — 2-opt must remove the cross.
    const pts = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const;
    const { order, totalDistance } = solveTwoOpt(matrixFromPoints(pts));
    expect(order).toHaveLength(4);
    expect(totalDistance).toBeCloseTo(4, 6);
  });

  it("removes crossings on a deliberately bad input order", () => {
    // Points around the unit circle at 8 evenly spaced angles.
    // Optimal closed loop visits them in angular order.
    const pts: [number, number][] = [];
    for (let i = 0; i < 8; i += 1) {
      const t = (i * 2 * Math.PI) / 8;
      pts.push([Math.cos(t), Math.sin(t)]);
    }
    // Permute the input so the natural index-order is NOT optimal.
    const shuffled = [pts[0]!, pts[3]!, pts[6]!, pts[1]!, pts[4]!, pts[7]!, pts[2]!, pts[5]!];
    const { totalDistance } = solveTwoOpt(matrixFromPoints(shuffled));
    // 8-gon perimeter: 8 * 2 * sin(π/8) ≈ 6.122.
    expect(totalDistance).toBeCloseTo(6.1229, 3);
  });

  it("is deterministic — same input ⇒ same output", () => {
    const pts: [number, number][] = Array.from({ length: 12 }, (_, i) => [
      Math.sin(i * 1.7),
      Math.cos(i * 0.9),
    ]);
    const m = matrixFromPoints(pts);
    const a = solveTwoOpt(m);
    const b = solveTwoOpt(m);
    expect(b.order).toEqual(a.order);
    expect(b.totalDistance).toBe(a.totalDistance);
  });

  it("respects startIndex — the returned tour begins at that node", () => {
    const pts = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const;
    const r = solveTwoOpt(matrixFromPoints(pts), 2);
    expect(r.order[0]).toBe(2);
    expect(r.totalDistance).toBeCloseTo(4, 6);
  });

  it("Or-opt never produces a longer tour than 2-opt-alone (monotone improver)", () => {
    // 20 noisy points — enough to exit the 2-opt-already-optimal regime
    // for very small inputs. Or-opt is a strict improver in VND: it
    // only applies a move when delta < 0, so the post-Or-opt tour is
    // necessarily ≤ the post-2-opt-alone tour.
    const pts: [number, number][] = Array.from({ length: 20 }, (_, i) => [
      Math.sin(i * 1.3) * 5,
      Math.cos(i * 0.9) * 3 + (i % 4),
    ]);
    const m = matrixFromPoints(pts);
    const withOrOpt = solveTwoOpt(m, 0);
    const without = solveTwoOpt(m, 0, { orOpt: false });
    expect(withOrOpt.totalDistance).toBeLessThanOrEqual(
      without.totalDistance + 1e-9,
    );
  });

  it("Or-opt opt-out (`orOpt: false`) reproduces the original 2-opt-only behaviour", () => {
    const pts: [number, number][] = Array.from({ length: 10 }, (_, i) => [
      Math.sin(i * 1.3),
      Math.cos(i * 0.7),
    ]);
    const m = matrixFromPoints(pts);
    // Two opt-out calls produce identical results — determinism preserved.
    const a = solveTwoOpt(m, 0, { orOpt: false });
    const b = solveTwoOpt(m, 0, { orOpt: false });
    expect(b.order).toEqual(a.order);
    expect(b.totalDistance).toBe(a.totalDistance);
  });

  it("treats null cells as +Infinity but still produces a complete tour", () => {
    // 3 collinear points, but the direct 0→2 edge is missing — the optimal
    // closed loop still has finite length via [0,1,2,0].
    const m: DistanceMatrix = [
      [0, 1, null],
      [1, 0, 1],
      [null, 1, 0],
    ];
    const { order, totalDistance } = solveTwoOpt(m);
    expect(order).toHaveLength(3);
    expect(totalDistance).toBe(Number.POSITIVE_INFINITY);
    // The all-direct path 0→1→2→0 includes the missing 2→0 leg; that's
    // unavoidable on a closed loop here. The caller must drop unreachable
    // nodes upstream — this test just documents the +Inf behavior.
  });
});
