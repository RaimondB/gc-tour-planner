// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { dbscan } from "./dbscan.js";
import type { ProjectedPoint } from "./equirectangular.js";

function pts(xy: readonly (readonly [number, number])[]): ProjectedPoint[] {
  return xy.map(([x, y]) => ({ x, y }));
}

describe("dbscan", () => {
  it("groups one tight cluster", () => {
    const { clusters, noise } = dbscan(
      pts([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]),
      5,
      3,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sort()).toEqual([0, 1, 2, 3]);
    expect(noise).toHaveLength(0);
  });

  it("separates two clusters with a noise point between", () => {
    const { clusters, noise } = dbscan(
      pts([
        // Cluster A around (0, 0)
        [0, 0],
        [2, 0],
        [0, 2],
        // Lone noise point
        [50, 50],
        // Cluster B around (100, 100)
        [100, 100],
        [102, 100],
        [100, 102],
      ]),
      5,
      3,
    );
    expect(clusters).toHaveLength(2);
    expect(noise).toEqual([3]);
  });

  it("is deterministic — same input ⇒ same clusters in same order", () => {
    const input = pts([
      [0, 0],
      [1, 0],
      [0, 1],
      [100, 100],
      [101, 100],
      [100, 101],
    ]);
    const a = dbscan(input, 5, 3);
    const b = dbscan(input, 5, 3);
    expect(b.clusters).toEqual(a.clusters);
    expect(b.noise).toEqual(a.noise);
  });
});
