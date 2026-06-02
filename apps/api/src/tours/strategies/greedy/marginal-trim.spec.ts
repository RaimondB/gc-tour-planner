// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  medianInterCacheDistance,
  resolveMarginalTrimThreshold,
  trimMarginalCaches,
} from "./marginal-trim.js";

describe("medianInterCacheDistance", () => {
  it("returns 0 for an empty matrix", () => {
    expect(medianInterCacheDistance([])).toBe(0);
  });

  it("ignores the diagonal", () => {
    // Diagonal is 0, off-diagonal is 500/700/900. Median should be 700.
    expect(
      medianInterCacheDistance([
        [0, 500, 700],
        [500, 0, 900],
        [700, 900, 0],
      ]),
    ).toBe(700);
  });

  it("ignores null cells (unreachable pairs)", () => {
    expect(
      medianInterCacheDistance([
        [0, 100, null],
        [100, 0, 200],
        [null, 200, 0],
      ]),
    ).toBe(200);
  });
});

describe("trimMarginalCaches", () => {
  it("keeps every cache when no marginal exceeds the threshold", async () => {
    // 4 caches in a roughly linear arrangement; consecutive walks ~500 m.
    const ids = [10, 11, 12, 13];
    const d = [
      [0, 500, 1000, 1500],
      [500, 0, 500, 1000],
      [1000, 500, 0, 500],
      [1500, 1000, 500, 0],
    ];
    const out = await trimMarginalCaches({
      orderedIds: ids,
      originalIds: ids,
      distances: d,
      thresholdMeters: 1000,
      minRemaining: 2,
    });
    expect(out.droppedIds).toEqual([]);
    expect(out.orderedIds).toEqual(ids);
    expect(out.savedMeters).toBe(0);
  });

  it("drops the interior cache that's the worst detour", async () => {
    // 4 caches; cache 12 is the marginal one — it costs 4000 m total to
    // visit (prev/next), but the prev→next leg without it is only 100 m.
    const ids = [10, 11, 12, 13];
    const d = [
      [0, 100, 100, 100],
      [100, 0, 2000, 100],
      [100, 2000, 0, 2000],
      [100, 100, 2000, 0],
    ];
    const out = await trimMarginalCaches({
      orderedIds: ids,
      originalIds: ids,
      distances: d,
      thresholdMeters: 500,
      minRemaining: 2,
    });
    expect(out.droppedIds).toContain(12);
    expect(out.orderedIds).not.toContain(12);
    expect(out.savedMeters).toBeGreaterThan(0);
  });

  it("conservatively keeps endpoints when parking distances are not supplied", async () => {
    // 3-cache tour where the FIRST cache looks bad but the trim has no
    // parking-distance arrays, so it can't compute endpoint marginals.
    // Test verifies we don't accidentally trim endpoints without the data.
    const ids = [10, 11, 12];
    const d = [
      [0, 100, 5000],
      [100, 0, 100],
      [5000, 100, 0],
    ];
    const out = await trimMarginalCaches({
      orderedIds: ids,
      originalIds: ids,
      distances: d,
      thresholdMeters: 200,
      minRemaining: 2,
    });
    // First and last are 10 and 12 — both must remain.
    expect(out.orderedIds[0]).toBe(10);
    expect(out.orderedIds[out.orderedIds.length - 1]).toBe(12);
  });

  it("trims the LAST cache when parking distances flag it as the worst", async () => {
    // 4-cache tour. Cache 13 (last) is a barrier-stuck cache:
    //   secondLast(12) → last(13)  = 2300 m
    //   last(13) → parking         = 1200 m
    //   secondLast(12) → parking   = 200 m   (much shorter direct)
    // marginal(13) = 2300 + 1200 − 200 = 3300 m  → above threshold.
    const ids = [10, 11, 12, 13];
    const d = [
      [0, 300, 600, 900],
      [300, 0, 300, 600],
      [600, 300, 0, 2300],
      [900, 600, 2300, 0],
    ];
    const parkingToCacheM = [200, 200, 200, 1200]; // last is far via parking
    const cacheToParkingM = [200, 200, 200, 1200];
    const out = await trimMarginalCaches({
      orderedIds: ids,
      originalIds: ids,
      distances: d,
      parkingToCacheM,
      cacheToParkingM,
      thresholdMeters: 800,
      minRemaining: 2,
    });
    expect(out.droppedIds).toContain(13);
    expect(out.orderedIds).not.toContain(13);
  });

  it("respects minRemaining as a hard floor", async () => {
    // Construct a tour where every interior cache is marginal. With
    // minRemaining=3, we should stop trimming once we'd go below.
    const ids = [10, 11, 12, 13, 14];
    const d = [
      [0, 100, 2000, 2000, 100],
      [100, 0, 2000, 2000, 100],
      [2000, 2000, 0, 2000, 2000],
      [2000, 2000, 2000, 0, 2000],
      [100, 100, 2000, 2000, 0],
    ];
    const out = await trimMarginalCaches({
      orderedIds: ids,
      originalIds: ids,
      distances: d,
      thresholdMeters: 500,
      minRemaining: 3,
    });
    expect(out.orderedIds.length).toBeGreaterThanOrEqual(3);
  });

  it("returns input unchanged when thresholdMeters is 0 (disabled)", async () => {
    const ids = [10, 11, 12];
    const d = [
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
    ];
    const out = await trimMarginalCaches({
      orderedIds: ids,
      originalIds: ids,
      distances: d,
      thresholdMeters: 0,
      minRemaining: 2,
    });
    expect(out.orderedIds).toEqual(ids);
    expect(out.droppedIds).toEqual([]);
  });
});

describe("resolveMarginalTrimThreshold", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.PLANNER_MARGINAL_DROP_ENABLED;
    delete process.env.PLANNER_MARGINAL_DROP_RATIO;
    delete process.env.PLANNER_MARGINAL_DROP_ABS_M;
    delete process.env.PLANNER_MARGINAL_DROP_HARD_MAX_M;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 0 when disabled", () => {
    process.env.PLANNER_MARGINAL_DROP_ENABLED = "false";
    expect(
      resolveMarginalTrimThreshold([
        [0, 500],
        [500, 0],
      ]),
    ).toBe(0);
  });

  it("uses max(abs floor, ratio × median)", () => {
    // Median = 500, ratio defaults to 2.0, abs floor defaults to 500.
    // max(500, 1000) = 1000.
    const d = [
      [0, 500, 500],
      [500, 0, 500],
      [500, 500, 0],
    ];
    expect(resolveMarginalTrimThreshold(d)).toBe(1000);
  });

  it("honours custom env overrides", () => {
    process.env.PLANNER_MARGINAL_DROP_RATIO = "1.0";
    process.env.PLANNER_MARGINAL_DROP_ABS_M = "100";
    process.env.PLANNER_MARGINAL_DROP_HARD_MAX_M = "100000";
    const d = [
      [0, 800, 800],
      [800, 0, 800],
      [800, 800, 0],
    ];
    expect(resolveMarginalTrimThreshold(d)).toBe(800);
  });

  it("caps the threshold at hard-max even with a poisoned median", () => {
    // River-archipelago case: most pairs are 10 km+ because of barrier
    // detours. Median = 10000, ratio × median = 20000, but the hard
    // max (default 3000) clamps it.
    const d = [
      [0, 10000, 10000, 10000],
      [10000, 0, 10000, 10000],
      [10000, 10000, 0, 10000],
      [10000, 10000, 10000, 0],
    ];
    expect(resolveMarginalTrimThreshold(d)).toBe(3000);
  });

  it("hard-max can be raised above the default", () => {
    process.env.PLANNER_MARGINAL_DROP_HARD_MAX_M = "50000";
    const d = [
      [0, 10000, 10000],
      [10000, 0, 10000],
      [10000, 10000, 0],
    ];
    // ratio (2.0) × median (10000) = 20000, well under the raised cap.
    expect(resolveMarginalTrimThreshold(d)).toBe(20000);
  });
});
