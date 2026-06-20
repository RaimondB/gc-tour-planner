// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { clusterByPixelProximity } from "./pixel-cluster.js";

// Test projection: 100 screen px per degree, y inverted — enough to reason about
// pixel distances deterministically without a real map.
const project = ([lng, lat]: [number, number]) => ({
  x: lng * 100,
  y: -lat * 100,
});

const pt = (lng: number, lat: number, id: number) => ({ lng, lat, item: id });

describe("clusterByPixelProximity", () => {
  it("keeps points far apart as singletons", () => {
    const clusters = clusterByPixelProximity(
      [pt(0, 0, 1), pt(1, 0, 2)], // 100 px apart
      project,
      20,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it("merges points whose markers overlap and averages their centre", () => {
    const clusters = clusterByPixelProximity(
      [pt(0, 0, 1), pt(0.1, 0, 2), pt(0.2, 0, 3)], // 10 px, 10 px apart
      project,
      20,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(clusters[0]!.center[0]).toBeCloseTo(0.1, 6);
    expect(clusters[0]!.center[1]).toBeCloseTo(0, 6);
  });

  it("respects the threshold (a point just beyond it stays separate)", () => {
    const clusters = clusterByPixelProximity(
      [pt(0, 0, 1), pt(0.21, 0, 2)], // 21 px apart, threshold 20
      project,
      20,
    );
    expect(clusters).toHaveLength(2);
  });
});
