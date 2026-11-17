// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { WalkReplanResult } from "@gctp/shared/walks";
import { calibrate, paceFactor } from "./calibration.js";
import { walkToPlanResult } from "./walk-to-tour.js";
import { deadlineGuard } from "./deadline-guard.js";
import { autoReplanReason, distanceToPath } from "./replan-trigger.js";
import {
  nextStopId,
  walkReducer,
  type LngLat,
  type WalkSession,
} from "./walk-session.js";

const HOME: LngLat = [5.12, 52.09];
const T0 = Date.parse("2026-11-17T10:00:00Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
/** A point `meters` north of home. */
const north = (meters: number): LngLat => [HOME[0], HOME[1] + meters / 111_195];

function session(over: Partial<WalkSession> = {}): WalkSession {
  return {
    id: "w1",
    startedAt: iso(0),
    profileId: null,
    profileName: "Test",
    profile: RouteProfileSettings.parse({}), // 5 km/h, 10 min buffer
    deadline: iso(120),
    returnPoint: HOME,
    startPoint: HOME,
    log: [],
    atCache: null,
    lockedNextId: null,
    plan: null,
    plannedAt: null,
    plannedVisitMs: {},
    knownStops: {},
    calibration: { paceFactor: 1, dwellFactor: 1 },
    pendingFinds: [],
    track: [],
    ...over,
  };
}

function stop(cacheId: number, arriveAt: string, leaveAt: string) {
  return {
    cacheId,
    code: `GC${cacheId}`,
    name: `Cache ${cacheId}`,
    type: "Traditional" as const,
    location: north(cacheId * 300),
    arriveAt,
    leaveAt,
  };
}

function plan(over: Partial<WalkReplanResult> = {}): WalkReplanResult {
  return {
    feasible: true,
    kept: "new",
    reason: "",
    order: [stop(1, iso(10), iso(15)), stop(2, iso(25), iso(30))],
    returnAt: iso(60),
    leaveLastBy: iso(80),
    slackMinutes: 50,
    minutesToReturn: 0,
    geometry: { type: "LineString", coordinates: [HOME, north(1000), HOME] },
    nextLeg: null,
    candidates: 2,
    ...over,
  };
}

describe("walkReducer", () => {
  it("logs a visit once, ending the arrival and any lock on it", () => {
    let s = session({ lockedNextId: 1 });
    s = walkReducer(s, { type: "arrived", cacheId: 1, at: iso(10) });
    s = walkReducer(s, {
      type: "logged",
      cacheId: 1,
      outcome: "found",
      at: iso(14),
    });
    s = walkReducer(s, {
      type: "logged",
      cacheId: 1,
      outcome: "dnf",
      at: iso(15),
    });
    expect(s.log).toEqual([
      { cacheId: 1, outcome: "found", arrivedAt: iso(10), at: iso(14) },
    ]);
    expect(s.atCache).toBeNull();
    expect(s.lockedNextId).toBeNull();
    expect(s.pendingFinds).toEqual([1]);
  });

  it("only queues finds, and drops them once flushed", () => {
    let s = walkReducer(session(), {
      type: "logged",
      cacheId: 2,
      outcome: "skipped",
      at: iso(1),
    });
    expect(s.pendingFinds).toEqual([]);
    s = walkReducer(s, {
      type: "logged",
      cacheId: 3,
      outcome: "found",
      at: iso(2),
    });
    s = walkReducer(s, { type: "findsFlushed", cacheIds: [3] });
    expect(s.pendingFinds).toEqual([]);
  });

  it("thins the GPS track to ~20 m steps", () => {
    let s = session();
    s = walkReducer(s, { type: "tracked", point: [...HOME, T0] });
    s = walkReducer(s, { type: "tracked", point: [...north(5), T0 + 5_000] });
    s = walkReducer(s, { type: "tracked", point: [...north(30), T0 + 30_000] });
    expect(s.track).toHaveLength(2);
  });

  it("remembers planned visit times across replans", () => {
    let s = walkReducer(session(), {
      type: "planned",
      plan: plan(),
      at: iso(0),
    });
    s = walkReducer(s, {
      type: "planned",
      plan: plan({ order: [] }),
      at: iso(5),
    });
    expect(s.plannedVisitMs).toEqual({ 1: 300_000, 2: 300_000 });
  });

  it("walks to the locked stop first, else the plan's first unlogged", () => {
    const s = session({ plan: plan() });
    expect(nextStopId(s)).toBe(1);
    expect(nextStopId({ ...s, lockedNextId: 9 })).toBe(9);
    const logged = walkReducer(s, {
      type: "logged",
      cacheId: 1,
      outcome: "found",
      at: iso(1),
    });
    expect(nextStopId(logged)).toBe(2);
  });
});

describe("deadlineGuard", () => {
  it("is ok with plenty of time", () => {
    const g = deadlineGuard(session(), new Date(T0), north(1000));
    expect(g.status).toBe("ok");
    // 1 km × 1.3 at 5 km/h ≈ 15.6 min home; target 11:50 → slack ≈ 94 min.
    expect(g.minutesHome).toBeCloseTo(15.6, 1);
    expect(g.slackMinutes).toBeCloseTo(110 - 15.6, 1);
  });

  it("turns tight under 15 min of slack and says head back once home is due", () => {
    expect(
      deadlineGuard(session(), new Date(T0 + 90 * 60_000), north(1000)).status,
    ).toBe("tight");
    expect(
      deadlineGuard(session(), new Date(T0 + 100 * 60_000), north(1000)).status,
    ).toBe("head-back");
  });

  it("is late after the deadline", () => {
    expect(
      deadlineGuard(session(), new Date(T0 + 121 * 60_000), HOME).status,
    ).toBe("late");
  });

  it("shows a fresh plan's leave-by and spare time, but colours by the walk home", () => {
    // The plan fills the time (10 min spare) — still "ok": home is 3 min away.
    const s = session({
      plan: plan({ slackMinutes: 10, leaveLastBy: iso(80) }),
      plannedAt: iso(0),
    });
    const g = deadlineGuard(s, new Date(T0 + 60_000), north(200));
    expect(g.fromPlan).toBe(true);
    expect(g.status).toBe("ok");
    expect(g.slackMinutes).toBeCloseTo(9);
    expect(g.leaveBy.toISOString()).toBe(iso(80));
    // Far from home near the deadline, the walk home wins.
    const late = deadlineGuard(s, new Date(T0 + 95 * 60_000), north(2000));
    expect(late.status).toBe("head-back");
  });

  it("falls back to the straight-line estimate when the plan is stale", () => {
    const s = session({ plan: plan({ slackMinutes: 999 }), plannedAt: iso(0) });
    expect(
      deadlineGuard(s, new Date(T0 + 30 * 60_000), north(1000)).fromPlan,
    ).toBe(false);
  });
});

describe("calibration", () => {
  it("measures pace from walking segments only, once there's enough of it", () => {
    // 600 m in 6 min = 6 km/h against the 5 km/h profile → 1.2.
    const track: [number, number, number][] = [0, 1, 2, 3, 4, 5, 6].map(
      (k) => [...north(k * 100), T0 + k * 60_000] as [number, number, number],
    );
    // A standing pause (no movement for 5 min) doesn't count.
    track.push([...north(600), T0 + 11 * 60_000]);
    expect(paceFactor(session({ track }))).toBeCloseTo(1.2, 1);
    expect(paceFactor(session({ track: track.slice(0, 2) }))).toBe(1);
  });

  it("compares observed time at caches with what the plans said", () => {
    const s = session({
      plannedVisitMs: { 1: 300_000 },
      log: [{ cacheId: 1, outcome: "found", arrivedAt: iso(10), at: iso(20) }],
    });
    expect(calibrate(s).dwellFactor).toBeCloseTo(2);
  });
});

describe("autoReplanReason", () => {
  it("plans when there's no plan, waits 20 s, refreshes after 3 min", () => {
    expect(autoReplanReason(session(), new Date(T0), HOME, 10, null)).toBe(
      "no-plan",
    );
    const s = session({ plan: plan(), plannedAt: iso(0) });
    expect(
      autoReplanReason(s, new Date(T0 + 10_000), HOME, 10, HOME),
    ).toBeNull();
    expect(autoReplanReason(s, new Date(T0 + 3 * 60_000), HOME, 10, HOME)).toBe(
      "drift",
    );
  });

  it("replans when the walker has left the planned path", () => {
    const s = session({ plan: plan(), plannedAt: iso(0) });
    const away: LngLat = [HOME[0] + 0.01, HOME[1]]; // ~690 m east of the path
    expect(autoReplanReason(s, new Date(T0 + 60_000), away, 10, HOME)).toBe(
      "off-plan",
    );
    expect(
      autoReplanReason(s, new Date(T0 + 60_000), north(500), 10, HOME),
    ).toBeNull();
  });

  it("replans once something was logged or locked since the plan (e.g. offline)", () => {
    const s = session({
      plan: plan(),
      plannedAt: iso(0),
      log: [{ cacheId: 1, outcome: "skipped", arrivedAt: null, at: iso(1) }],
    });
    expect(autoReplanReason(s, new Date(T0 + 70_000), HOME, 10, HOME)).toBe(
      "changed",
    );
    const locked = session({
      plan: plan(),
      plannedAt: iso(0),
      lockedNextId: 2,
    });
    expect(
      autoReplanReason(locked, new Date(T0 + 70_000), HOME, 10, HOME),
    ).toBe("changed");
  });

  it("ignores poor fixes", () => {
    expect(
      autoReplanReason(session(), new Date(T0), HOME, 200, null),
    ).toBeNull();
  });

  it("measures distance to a polyline", () => {
    expect(
      distanceToPath([HOME[0] + 0.001, HOME[1] + 0.0045], [HOME, north(1000)]),
    ).toBeCloseTo(68, -1);
  });
});

describe("walkToPlanResult", () => {
  it("saves the visited caches (not skipped) along the walked track", () => {
    const s = session({
      knownStops: {
        1: {
          code: "GC1",
          name: "One",
          type: "Traditional",
          location: north(300),
        },
        2: { code: "GC2", name: "Two", type: "Multi", location: north(600) },
      },
      log: [
        { cacheId: 1, outcome: "found", arrivedAt: iso(10), at: iso(16) },
        { cacheId: 3, outcome: "skipped", arrivedAt: null, at: iso(20) },
        { cacheId: 2, outcome: "dnf", arrivedAt: iso(30), at: iso(34) },
      ],
      track: [
        [...HOME, T0],
        [...north(600), T0 + 30 * 60_000],
        [...HOME, T0 + 50 * 60_000],
      ],
    });
    const plan = walkToPlanResult(s, new Date(T0 + 50 * 60_000))!;
    expect(plan.orderedCacheIds).toEqual([1, 2]);
    expect(plan.polyline.coordinates).toHaveLength(3);
    expect(plan.totals.meters).toBeCloseTo(1200, -1);
    expect(plan.totals.seconds).toBe(3000);
    expect(plan.totals.visitMinutes).toBe(10);
    expect(plan.parking.point.coordinates).toEqual(HOME);
  });

  it("draws straight lines between stops without a GPS track, and is null with no visits", () => {
    const s = session({
      knownStops: {
        1: {
          code: "GC1",
          name: "One",
          type: "Traditional",
          location: north(300),
        },
      },
      log: [{ cacheId: 1, outcome: "found", arrivedAt: null, at: iso(10) }],
    });
    expect(walkToPlanResult(s, new Date(T0))!.polyline.coordinates).toEqual([
      HOME,
      north(300),
      HOME,
    ]);
    expect(walkToPlanResult(session(), new Date(T0))).toBeNull();
  });
});
