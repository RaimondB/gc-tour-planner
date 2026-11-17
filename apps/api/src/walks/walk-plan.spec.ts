// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { RouteProfiles } from "@gctp/shared";
import {
  cachePrize,
  keepPreviousRoute,
  insideReach,
  reachCircle,
  schedule,
  walkPace,
} from "./walk-plan.js";

const profile = RouteProfiles.RouteProfileSettings.parse({
  time: { walkingKmh: 4 },
  objective: {
    preferredTypes: ["Multi"],
    preferredWeight: 2,
    landuseWeight: 3,
  },
});

describe("walkPace (ADR-0040 §4)", () => {
  it("walks out at the calibrated pace but never back faster than the profile", () => {
    const fast = walkPace(profile, { paceFactor: 1.25, dwellFactor: 1 });
    expect(fast.outSecondsPerMeter).toBeCloseTo(3.6 / 5);
    expect(fast.backSecondsPerMeter).toBeCloseTo(3.6 / 4);
    const slow = walkPace(profile, { paceFactor: 0.8, dwellFactor: 1 });
    expect(slow.backSecondsPerMeter).toBeCloseTo(slow.outSecondsPerMeter);
  });

  it("clamps calibration to sane bounds", () => {
    const wild = walkPace(profile, { paceFactor: 4, dwellFactor: 0.1 });
    expect(wild.outSecondsPerMeter).toBeCloseTo(3.6 / (4 * 1.5));
    expect(wild.dwellFactor).toBe(0.5);
  });
});

describe("cachePrize (ADR-0040 §2)", () => {
  const forest = new Set(["forest"]);
  it("adds the preferred-type and scenic bonuses to the base 1", () => {
    expect(
      cachePrize({ type: "Traditional" }, [], profile.objective, forest),
    ).toBe(1);
    expect(cachePrize({ type: "Multi" }, [], profile.objective, forest)).toBe(
      3,
    );
    expect(
      cachePrize({ type: "Multi" }, ["forest"], profile.objective, forest),
    ).toBe(6);
  });
});

describe("reach", () => {
  const s: [number, number] = [5.1, 52.09];
  const e: [number, number] = [5.12, 52.09]; // ~1.37 km east
  it("keeps caches whose straight-line detour fits", () => {
    expect(insideReach(s, e, [5.11, 52.092], 2_000)).toBe(true);
    expect(insideReach(s, e, [5.11, 52.12], 2_000)).toBe(false);
  });
  it("bounds the ellipse with a circle around the midpoint", () => {
    const c = reachCircle(s, e, 2_000);
    expect(c.center[0]).toBeCloseTo(5.11);
    expect(c.center[1]).toBeCloseTo(52.09);
    expect(c.radiusM).toBe(1_000);
  });
});

const stop = (id: number) => ({
  id,
  code: `GC${id}`,
  name: `Cache ${id}`,
  type: "Traditional" as const,
  location: {
    type: "Point" as const,
    coordinates: [5.1, 52.1] as [number, number],
  },
});

describe("schedule", () => {
  it("lays out arrival / leave times and the return", () => {
    const start = Date.parse("2026-11-17T10:00:00Z");
    const res = schedule(
      start,
      [
        { cache: stop(1), travelSeconds: 600, visitSeconds: 300 },
        { cache: stop(2), travelSeconds: 300, visitSeconds: 300 },
      ],
      900,
    );
    expect(res.stops.map((s) => [s.cacheId, s.arriveAt, s.leaveAt])).toEqual([
      [1, "2026-11-17T10:10:00.000Z", "2026-11-17T10:15:00.000Z"],
      [2, "2026-11-17T10:20:00.000Z", "2026-11-17T10:25:00.000Z"],
    ]);
    expect(res.stops[0]).toMatchObject({
      code: "GC1",
      name: "Cache 1",
      type: "Traditional",
      location: [5.1, 52.1],
    });
    expect(new Date(res.returnMs).toISOString()).toBe(
      "2026-11-17T10:40:00.000Z",
    );
  });
});

describe("keepPreviousRoute (ADR-0040 §5)", () => {
  const rule = { scorePct: 10, saveSeconds: 600 };
  const prev = { score: 5, seconds: 3600, feasible: true, valid: true };

  it("keeps the current route when the new one isn't clearly better", () => {
    expect(keepPreviousRoute(prev, { score: 5.4, seconds: 3500 }, rule)).toBe(
      true,
    );
  });

  it("switches for at least a cache's worth more value", () => {
    expect(keepPreviousRoute(prev, { score: 6, seconds: 4000 }, rule)).toBe(
      false,
    );
  });

  it("switches for the same value in 10+ minutes less — e.g. after moving away", () => {
    expect(keepPreviousRoute(prev, { score: 5, seconds: 2900 }, rule)).toBe(
      false,
    );
    expect(keepPreviousRoute(prev, { score: 4.9, seconds: 2000 }, rule)).toBe(
      true,
    );
  });

  it("never keeps a route that no longer fits", () => {
    expect(
      keepPreviousRoute(
        { ...prev, feasible: false },
        { score: 1, seconds: 1 },
        rule,
      ),
    ).toBe(false);
  });
});
