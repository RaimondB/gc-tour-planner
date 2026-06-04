// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Geo } from "@gctp/shared";
import { describe, expect, it, vi } from "vitest";
import type { OsrmLeg } from "../../../routing/osrm.client.js";
import {
  DEFAULT_LOOP_PICKER_OPTIONS,
  OverlapGrid,
  perpendicularViaCandidates,
  pickAndAccumulate,
  pickLoopAwareLeg,
} from "./loop-aware-legs.js";

function line(...coords: [number, number][]): Geo.GeoJsonLineString {
  return { type: "LineString", coordinates: coords };
}

function leg(meters: number, ...coords: [number, number][]): OsrmLeg {
  return { meters, seconds: meters / 1.4, geometry: line(...coords) };
}

describe("OverlapGrid", () => {
  it("reports zero hits on an empty grid", () => {
    const g = new OverlapGrid(25);
    expect(g.overlapHits(line([6.0, 51.9], [6.001, 51.9]))).toBe(0);
  });

  it("counts coords in already-populated cells", () => {
    const g = new OverlapGrid(25);
    g.addLine(line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9]));
    // Same line replayed — every coord lands in a populated cell.
    expect(g.overlapHits(line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9]))).toBe(
      3,
    );
  });

  it("a parallel street 100 m away registers as zero overlap", () => {
    const g = new OverlapGrid(25);
    g.addLine(line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9]));
    // ~111 m north — well outside the 25 m grid cell.
    const parallel = line([6.0, 51.901], [6.001, 51.901], [6.002, 51.901]);
    expect(g.overlapHits(parallel)).toBe(0);
  });
});

describe("pickLoopAwareLeg", () => {
  it("returns null on empty input", () => {
    const g = new OverlapGrid(25);
    expect(pickLoopAwareLeg([], g)).toBeNull();
  });

  it("with an empty grid, picks the primary (shortest)", () => {
    const g = new OverlapGrid(25);
    const primary = leg(500, [6.0, 51.9], [6.005, 51.9]);
    const longer = leg(700, [6.0, 51.901], [6.005, 51.901]);
    const pick = pickLoopAwareLeg([primary, longer], g)!;
    expect(pick.chosenIndex).toBe(0);
    expect(pick.picked).toBe(primary);
  });

  it("prefers a non-overlapping alternative when primary retraces", () => {
    const g = new OverlapGrid(25);
    // Pre-load the grid with a "main street" the primary alternative will
    // exactly retrace.
    g.addLine(line([6.0, 51.9], [6.002, 51.9], [6.005, 51.9]));
    const retracingPrimary = leg(
      500,
      [6.0, 51.9],
      [6.002, 51.9],
      [6.005, 51.9],
    );
    const parallelAlt = leg(
      600, // 20 % longer but on a different street
      [6.0, 51.901],
      [6.002, 51.901],
      [6.005, 51.901],
    );
    const pick = pickLoopAwareLeg([retracingPrimary, parallelAlt], g)!;
    expect(pick.chosenIndex).toBe(1);
    expect(pick.overlapHits).toBe(0);
  });

  it("falls back to primary when every alt exceeds the detour cap", () => {
    const g = new OverlapGrid(25);
    g.addLine(line([6.0, 51.9], [6.005, 51.9]));
    const primary = leg(500, [6.0, 51.9], [6.005, 51.9]); // fully retraces
    // 80 % longer alt — over the default 50 % cap, must be rejected even
    // though it would avoid the overlap.
    const tooLongAlt = leg(900, [6.0, 51.91], [6.005, 51.91]);
    const pick = pickLoopAwareLeg([primary, tooLongAlt], g)!;
    expect(pick.chosenIndex).toBe(0);
  });

  it("alpha=0 disables loop preference (picks shortest)", () => {
    const g = new OverlapGrid(25);
    g.addLine(line([6.0, 51.9], [6.005, 51.9]));
    const primary = leg(500, [6.0, 51.9], [6.005, 51.9]); // fully retraces
    const parallelAlt = leg(550, [6.0, 51.901], [6.005, 51.901]);
    const pick = pickLoopAwareLeg([primary, parallelAlt], g, {
      ...DEFAULT_LOOP_PICKER_OPTIONS,
      alpha: 0,
    })!;
    expect(pick.chosenIndex).toBe(0);
  });
});

describe("perpendicularViaCandidates", () => {
  it("returns one ± pair per (fraction, offset) combo", () => {
    // 2 fractions × 2 offsets × 2 sides = 8 candidates.
    const cands = perpendicularViaCandidates(
      [6.0, 51.9],
      [6.005, 51.9],
      [80, 160],
      [0.33, 0.67],
    );
    expect(cands).toHaveLength(8);
    // Perpendicular to an east-west leg is north-south; half should be
    // north of 51.9 and half south.
    const north = cands.filter((c) => c[1] > 51.9).length;
    const south = cands.filter((c) => c[1] < 51.9).length;
    expect(north).toBe(4);
    expect(south).toBe(4);
  });

  it("default fractions=[0.5] returns 2 candidates per offset", () => {
    const cands = perpendicularViaCandidates([6.0, 51.9], [6.005, 51.9], [80]);
    expect(cands).toHaveLength(2);
    const ds = cands.map((c) => Math.abs(c[1] - 51.9));
    expect(ds[0]!).toBeCloseTo(80 / 111_320, 4);
  });

  it("returns no candidates when from == to", () => {
    expect(perpendicularViaCandidates([6.0, 51.9], [6.0, 51.9], [80])).toEqual(
      [],
    );
  });
});

describe("pickAndAccumulate via-waypoint nudge", () => {
  it("triggers the nudge when the alt-best retraces enough of the prior polyline", async () => {
    const grid = new OverlapGrid(25);
    grid.addLine(
      line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9], [6.003, 51.9]),
    );

    const primary: OsrmLeg = {
      meters: 400,
      seconds: 300,
      geometry: line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9], [6.003, 51.9]),
    };
    const nudgedAlt: OsrmLeg = {
      meters: 460,
      seconds: 340,
      geometry: line([6.0, 51.9], [6.0015, 51.901], [6.003, 51.9]),
    };
    const fetchAlternatives = vi.fn().mockResolvedValue([primary]);
    const fetchVia = vi.fn().mockResolvedValue(nudgedAlt);

    const chosen = await pickAndAccumulate({
      from: [6.0, 51.9],
      to: [6.003, 51.9],
      profile: "foot",
      count: 3,
      fetchAlternatives,
      fetchVia,
      grid,
    });

    expect(chosen?.picked).toBe(nudgedAlt);
    // Default nudge sweep: 1 fraction × 2 offsets × 2 sides = 4 fetches.
    expect(fetchVia).toHaveBeenCalledTimes(4);
  });

  it("keeps primary when fetchVia returns the same overlapping path", async () => {
    const grid = new OverlapGrid(25);
    grid.addLine(line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9]));
    const primary: OsrmLeg = {
      meters: 200,
      seconds: 150,
      geometry: line([6.0, 51.9], [6.001, 51.9], [6.002, 51.9]),
    };
    // "Snap-back" case: OSRM ignored the via and returned ~primary.
    const fetchAlternatives = vi.fn().mockResolvedValue([primary]);
    const fetchVia = vi.fn().mockResolvedValue(primary);

    const chosen = await pickAndAccumulate({
      from: [6.0, 51.9],
      to: [6.002, 51.9],
      profile: "foot",
      count: 3,
      fetchAlternatives,
      fetchVia,
      grid,
    });

    expect(chosen?.picked).toBe(primary);
  });

  it("skips the nudge for legs under 150 m", async () => {
    const grid = new OverlapGrid(25);
    grid.addLine(line([6.0, 51.9], [6.0005, 51.9]));
    const shortPrimary: OsrmLeg = {
      meters: 80,
      seconds: 60,
      geometry: line([6.0, 51.9], [6.0005, 51.9]),
    };
    const fetchAlternatives = vi.fn().mockResolvedValue([shortPrimary]);
    const fetchVia = vi.fn();

    await pickAndAccumulate({
      from: [6.0, 51.9],
      to: [6.0005, 51.9],
      profile: "foot",
      count: 3,
      fetchAlternatives,
      fetchVia,
      grid,
    });

    expect(fetchVia).not.toHaveBeenCalled();
  });
});
