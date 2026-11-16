// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { PlanResult } from "@gctp/shared/tours";
import type { GeoJsonLineString } from "@gctp/shared/geo";
import { applyLegEdits, type LegPicks } from "./persistent-state.js";

function line(coords: [number, number][]): GeoJsonLineString {
  return { type: "LineString", coordinates: coords };
}

const A = line([
  [0, 0],
  [1, 0],
]);
const B = line([
  [0, 0],
  [1, 0.1],
]);
const C = line([
  [1, 0],
  [2, 0],
]);
const D = line([
  [1, 0],
  [1.5, 0.5],
  [2, 0],
]);

/** Minimal 2-leg plan; only the fields applyLegEdits reads need to be real. */
function plan(): PlanResult {
  return {
    orderedCacheIds: [1, 2],
    droppedCacheIds: [],
    droppedCaches: [],
    polyline: line([
      [0, 0],
      [1, 0],
      [2, 0],
    ]),
    totals: { meters: 300, seconds: 180, visitMinutes: 10 },
    parking: {
      type: "user",
      point: { type: "Point", coordinates: [0, 0] },
      reason: "x",
      fallback: false,
    },
    scoreBreakdown: { density: 1 },
    legs: [
      {
        index: 0,
        fromCacheId: 0,
        toCacheId: 1,
        meters: 100,
        seconds: 60,
        geometry: A,
        alternatives: [
          { meters: 100, seconds: 60, geometry: A },
          { meters: 80, seconds: 50, geometry: B },
        ],
        selectedAlternativeIndex: 0,
      },
      {
        index: 1,
        fromCacheId: 1,
        toCacheId: 0,
        meters: 200,
        seconds: 120,
        geometry: C,
        alternatives: [{ meters: 200, seconds: 120, geometry: C }],
        selectedAlternativeIndex: 0,
      },
    ],
  };
}

describe("applyLegEdits", () => {
  it("returns the plan unchanged when there are no edits", () => {
    const p = plan();
    expect(applyLegEdits(p, {})).toBe(p);
  });

  it("bakes an alt pick into the leg envelope + totals", () => {
    const picks: LegPicks = { 0: { kind: "alt", altIndex: 1 } };
    const out = applyLegEdits(plan(), picks);
    expect(out.legs[0]!.meters).toBe(80);
    expect(out.legs[0]!.seconds).toBe(50);
    expect(out.legs[0]!.geometry).toEqual(B);
    expect(out.legs[0]!.selectedAlternativeIndex).toBe(1);
    // Totals recomputed from resolved legs (80 + 200).
    expect(out.totals.meters).toBe(280);
    expect(out.totals.seconds).toBe(170);
    // visitMinutes untouched.
    expect(out.totals.visitMinutes).toBe(10);
  });

  it("bakes a via pick by appending + selecting a new alternative", () => {
    const picks: LegPicks = {
      1: {
        kind: "via",
        via: [1.5, 0.5],
        meters: 250,
        seconds: 150,
        geometry: D,
      },
    };
    const out = applyLegEdits(plan(), picks);
    const leg = out.legs[1]!;
    expect(leg.meters).toBe(250);
    expect(leg.geometry).toEqual(D);
    // The via geometry is appended and selected so a reopen re-renders it.
    expect(leg.alternatives).toHaveLength(2);
    expect(leg.selectedAlternativeIndex).toBe(1);
    expect(leg.alternatives[1]!.geometry).toEqual(D);
    // Totals: leg0 unedited (100) + leg1 via (250).
    expect(out.totals.meters).toBe(350);
  });

  it("recomputes the polyline from the edited legs", () => {
    const picks: LegPicks = { 0: { kind: "alt", altIndex: 1 } };
    const out = applyLegEdits(plan(), picks);
    // First leg now follows B; the stitched polyline starts along it.
    expect(out.polyline.coordinates[1]).toEqual([1, 0.1]);
  });
});
