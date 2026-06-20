// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  expandColocatedRoute,
  type LegWithAlternatives,
} from "./expand-colocated.js";

const geom = (coords: [number, number][]): LegWithAlternatives["geometry"] => ({
  type: "LineString",
  coordinates: coords,
});

/** A real OSRM-style leg (≥1 alternative), like the picker produces. */
function realLeg(from: number, to: number): LegWithAlternatives {
  const g = geom([
    [0, 0],
    [1, 1],
  ]);
  return {
    fromCacheId: from,
    toCacheId: to,
    profile: "foot",
    meters: 100,
    seconds: 72,
    geometry: g,
    alternatives: [{ meters: 100, seconds: 72, geometry: g }],
    selectedIndex: 0,
  };
}

// Coordinates: 10 & 11 are ~a couple metres apart (one group), 20 is far.
const COORD: Record<number, [number, number]> = {
  10: [6.39465, 52.14477],
  11: [6.39463, 52.14478],
  20: [6.4, 52.15],
};

describe("expandColocatedRoute", () => {
  it("expands a co-located group into member stops with valid legs (regression: every leg has ≥1 alternative)", () => {
    const reps = [10, 20];
    const members = (rep: number) => (rep === 10 ? [10, 11] : [20]);
    const { orderedIds, allLegs } = expandColocatedRoute(
      reps,
      members,
      (id) => COORD[id]!,
      {
        parkingToFirst: realLeg(0, 10),
        interCacheLegs: [realLeg(10, 20)],
        lastToParking: realLeg(20, 0),
      },
    );

    // Members emitted contiguously; group 10 → [10, 11], then 20.
    expect(orderedIds).toEqual([10, 11, 20]);
    // Wire invariant.
    expect(allLegs.length).toBe(orderedIds.length + 1);
    // The regression: PlanLeg requires alternatives.min(1) — no empty arrays,
    // including the synthesized co-located leg.
    for (const leg of allLegs) {
      expect(leg.alternatives.length).toBeGreaterThanOrEqual(1);
    }
    // The synthesized 10→11 leg is short and has its self-alternative.
    const synth = allLegs.find(
      (l) => l.fromCacheId === 10 && l.toCacheId === 11,
    );
    expect(synth).toBeDefined();
    expect(synth!.meters).toBeLessThan(20);
    // The inter-group leg is relabelled from the group's last member (11) → 20.
    expect(
      allLegs.some((l) => l.fromCacheId === 11 && l.toCacheId === 20),
    ).toBe(true);
  });

  it("is a no-op shape for singleton groups (no synthesized legs)", () => {
    const { orderedIds, allLegs } = expandColocatedRoute(
      [10, 20],
      (rep) => [rep],
      (id) => COORD[id]!,
      {
        parkingToFirst: realLeg(0, 10),
        interCacheLegs: [realLeg(10, 20)],
        lastToParking: realLeg(20, 0),
      },
    );
    expect(orderedIds).toEqual([10, 20]);
    expect(allLegs.length).toBe(3);
    for (const leg of allLegs)
      expect(leg.alternatives.length).toBeGreaterThanOrEqual(1);
  });
});
