// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { collapseByProximity, collapseLabel } from "./marker-collapse.js";

// 1:1 projector — treats lng/lat as screen x/y so tests control pixel overlap
// directly. Distances are then plain Euclidean in "coordinate units" == px.
const project = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });

interface Stop {
  order: number | null;
  coord: [number, number];
}

const pt = (s: Stop) => ({ lng: s.coord[0], lat: s.coord[1], item: s });

describe("collapseLabel", () => {
  it("renders a contiguous ordinal run as min–max", () => {
    expect(collapseLabel([3, 4, 5])).toBe("3–5");
    expect(collapseLabel([5, 3, 4])).toBe("3–5"); // order-independent
    expect(collapseLabel([1, 2])).toBe("1–2");
  });

  it("renders a non-contiguous run as ×count", () => {
    expect(collapseLabel([2, 5])).toBe("×2");
    expect(collapseLabel([1, 2, 4])).toBe("×3");
  });

  it("falls back to ×count when any ordinal is missing", () => {
    expect(collapseLabel([1, null, 3])).toBe("×3");
    expect(collapseLabel([undefined, undefined])).toBe("×2");
  });
});

describe("collapseByProximity", () => {
  it("keeps far-apart points as singles", () => {
    const a: Stop = { order: 1, coord: [0, 0] };
    const b: Stop = { order: 2, coord: [100, 100] };
    const { singles, groups } = collapseByProximity([pt(a), pt(b)], project, {
      thresholdPx: 20,
      order: (s) => s.order,
    });
    expect(groups).toHaveLength(0);
    expect(singles).toEqual([a, b]);
  });

  it("merges overlapping points into one group with a range label", () => {
    const a: Stop = { order: 3, coord: [0, 0] };
    const b: Stop = { order: 4, coord: [5, 5] };
    const far: Stop = { order: 9, coord: [500, 500] };
    const { singles, groups } = collapseByProximity(
      [pt(a), pt(b), pt(far)],
      project,
      { thresholdPx: 20, order: (s) => s.order },
    );
    expect(singles).toEqual([far]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.label).toBe("3–4");
    expect(groups[0]!.members).toEqual([a, b]);
    // Centroid of (0,0) and (5,5).
    expect(groups[0]!.center).toEqual([2.5, 2.5]);
  });

  it("labels a non-contiguous merged group as ×count", () => {
    const a: Stop = { order: 2, coord: [0, 0] };
    const b: Stop = { order: 7, coord: [3, 3] };
    const { groups } = collapseByProximity([pt(a), pt(b)], project, {
      thresholdPx: 20,
      order: (s) => s.order,
    });
    expect(groups[0]!.label).toBe("×2");
  });

  it("labels groups as ×count when no order accessor is given (AL stages)", () => {
    const a: Stop = { order: null, coord: [0, 0] };
    const b: Stop = { order: null, coord: [2, 2] };
    const c: Stop = { order: null, coord: [4, 4] };
    const { groups } = collapseByProximity([pt(a), pt(b), pt(c)], project, {
      thresholdPx: 20,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("×3");
  });
});
