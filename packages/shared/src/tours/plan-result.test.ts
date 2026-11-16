// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { DroppedCache, PlanResult } from "./plan-result.js";

/** Minimal valid PlanResult body without the additive drop-reason fields. */
const legacy = {
  orderedCacheIds: [1, 2, 3],
  droppedCacheIds: [4],
  polyline: {
    type: "LineString",
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
  totals: { meters: 100, seconds: 200, visitMinutes: 15 },
  parking: {
    type: "osrm-nearest",
    point: { type: "Point", coordinates: [0, 0] },
    reason: "nearest",
  },
  scoreBreakdown: {},
};

describe("PlanResult.droppedCaches back-compat", () => {
  it("defaults droppedCaches to [] for plans saved before the field existed", () => {
    const parsed = PlanResult.parse(legacy);
    expect(parsed.droppedCaches).toEqual([]);
    // The legacy flat list is untouched.
    expect(parsed.droppedCacheIds).toEqual([4]);
  });

  it("parses structured drop reasons with an optional budget hint", () => {
    const parsed = PlanResult.parse({
      ...legacy,
      droppedCaches: [
        { id: 4, reason: "budget", neededBudgetMeters: 1200 },
        { id: 5, reason: "unreachable" },
      ],
    });
    expect(parsed.droppedCaches).toEqual([
      { id: 4, reason: "budget", neededBudgetMeters: 1200 },
      { id: 5, reason: "unreachable" },
    ]);
  });

  it("rejects an unknown drop reason", () => {
    expect(() => DroppedCache.parse({ id: 1, reason: "made-up" })).toThrow();
  });
});

describe("PlanResult non-finite guard", () => {
  // A leaked Infinity/NaN serialises to JSON `null` and is dropped *silently* by
  // the web's PlanResult.parse. The `.finite()` constraints make the same parse a
  // loud server-side guard before the value ever leaves the API — paired with the
  // metric closure that stops ∞ legs from arising in the first place.
  it("rejects a non-finite total", () => {
    expect(() =>
      PlanResult.parse({
        ...legacy,
        totals: { meters: Infinity, seconds: 200, visitMinutes: 15 },
      }),
    ).toThrow();
  });

  it("rejects a non-finite scoreBreakdown value", () => {
    expect(() =>
      PlanResult.parse({
        ...legacy,
        scoreBreakdown: { marginalTrimSavedMeters: Infinity },
      }),
    ).toThrow();
  });

  it("rejects a NaN leg distance", () => {
    expect(() =>
      PlanResult.parse({
        ...legacy,
        legs: [
          {
            index: 0,
            fromCacheId: 0,
            toCacheId: 1,
            meters: NaN,
            seconds: 10,
            geometry: {
              type: "LineString",
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            alternatives: [
              {
                meters: 10,
                seconds: 10,
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [0, 0],
                    [1, 1],
                  ],
                },
              },
            ],
            selectedAlternativeIndex: 0,
          },
        ],
      }),
    ).toThrow();
  });

  it("still accepts a fully-finite plan", () => {
    expect(() => PlanResult.parse(legacy)).not.toThrow();
  });
});
