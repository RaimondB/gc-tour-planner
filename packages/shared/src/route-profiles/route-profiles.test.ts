// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { RouteProfileSettings, SaveRouteProfileInput } from "./index.js";

describe("RouteProfileSettings", () => {
  it("fills every field from defaults when given an empty object", () => {
    const s = RouteProfileSettings.parse({});
    expect(s.version).toBe(1);
    expect(s.filters).toMatchObject({
      types: [],
      difficulty: { min: 1, max: 5 },
      terrain: { min: 1, max: 5 },
      includeAdventureLabs: true,
      excludeSavedTourCaches: true,
    });
    expect(s.adventures).toEqual({ keepTogether: true, interleave: true });
    expect(s.time).toMatchObject({
      visitMinutes: 5,
      visitMinutesByType: {},
      walkingKmh: 5,
      bufferMinutes: 10,
    });
    expect(s.budget).toEqual({
      distanceBudgetMeters: 8000,
      defaultDurationMinutes: null,
    });
  });

  it("keeps given fields and defaults the rest of a partial group", () => {
    // A profile stored before a field existed must still parse completely.
    const s = RouteProfileSettings.parse({
      time: { visitMinutes: 8, visitMinutesByType: { Multi: 20 } },
    });
    expect(s.time.visitMinutes).toBe(8);
    expect(s.time.visitMinutesByType).toEqual({ Multi: 20 });
    expect(s.time.alStageVisitMinutes).toBe(2);
  });

  it("rejects an inverted D/T range", () => {
    expect(
      RouteProfileSettings.safeParse({
        filters: { difficulty: { min: 4, max: 2 } },
      }).success,
    ).toBe(false);
  });

  it("rejects ratings off the half-step scale", () => {
    expect(
      RouteProfileSettings.safeParse({
        filters: { terrain: { min: 1.25, max: 3 } },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown cache type in a per-type visit time", () => {
    expect(
      RouteProfileSettings.safeParse({
        time: { visitMinutesByType: { Geocache: 10 } },
      }).success,
    ).toBe(false);
  });

  it("rejects a future settings version", () => {
    expect(RouteProfileSettings.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe("SaveRouteProfileInput", () => {
  it("trims the name and defaults the description", () => {
    const p = SaveRouteProfileInput.parse({ name: "  Forest  ", settings: {} });
    expect(p.name).toBe("Forest");
    expect(p.description).toBeNull();
  });

  it("rejects a blank name", () => {
    expect(
      SaveRouteProfileInput.safeParse({ name: "   ", settings: {} }).success,
    ).toBe(false);
  });
});
