// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { RouteProfileSettings } from "@gctp/shared/route-profiles";
import { DEFAULT_SEARCH } from "../../lib/search-params.js";
import { DEFAULT_PLAN_SETTINGS } from "../planning/PlannerSidebar.js";
import {
  applyRouteProfile,
  plannerDiffersFromProfile,
  profileFromPlanner,
} from "./profile-mapping.js";

const quickTrads = RouteProfileSettings.parse({
  filters: {
    types: ["Traditional"],
    difficulty: { min: 1, max: 2.5 },
    terrain: { min: 1, max: 2.5 },
    includeAdventureLabs: false,
  },
  objective: { varietyWeight: 0 },
  time: { visitMinutes: 3, visitMinutesByType: { Multi: 20 } },
  budget: { distanceBudgetMeters: 5000, defaultDurationMinutes: 60 },
});

const start = { search: DEFAULT_SEARCH, plan: DEFAULT_PLAN_SETTINGS };

describe("applyRouteProfile", () => {
  it("fills the filters and plan settings the profile covers", () => {
    const { search, plan } = applyRouteProfile(quickTrads, start);
    expect(search.types).toEqual(["Traditional"]);
    expect(search.difficulty).toEqual({ min: 1, max: 2.5 });
    expect(plan.includeAdventuresInClustering).toBe(false);
    expect(plan.timePerCacheMinutes).toBe(3);
    expect(plan.distanceBudgetMeters).toBe(5000);
    expect(plan.landuseProfileId).toBeUndefined();
  });

  it("leaves area, display and expert settings alone", () => {
    const custom = {
      search: {
        ...DEFAULT_SEARCH,
        center: [4.9, 52.37] as [number, number],
        radiusM: 8000,
        showLanduse: true,
      },
      plan: {
        ...DEFAULT_PLAN_SETTINGS,
        maxLinkMeters: 900,
        topNClusters: 9,
        startPreference: "osm-parking" as const,
      },
    };
    const { search, plan } = applyRouteProfile(quickTrads, custom);
    expect(search.center).toEqual([4.9, 52.37]);
    expect(search.radiusM).toBe(8000);
    expect(search.showLanduse).toBe(true);
    expect(plan.maxLinkMeters).toBe(900);
    expect(plan.topNClusters).toBe(9);
    expect(plan.startPreference).toBe("osm-parking");
  });
});

describe("profileFromPlanner", () => {
  it("round-trips a profile through the planner unchanged", () => {
    const applied = applyRouteProfile(quickTrads, start);
    expect(profileFromPlanner(applied, quickTrads)).toEqual(quickTrads);
  });

  it("keeps walk-only fields from the base profile", () => {
    const applied = applyRouteProfile(quickTrads, start);
    const saved = profileFromPlanner(
      { ...applied, plan: { ...applied.plan, distanceBudgetMeters: 6000 } },
      quickTrads,
    );
    expect(saved.budget).toEqual({
      distanceBudgetMeters: 6000,
      defaultDurationMinutes: 60,
    });
    expect(saved.time.visitMinutesByType).toEqual({ Multi: 20 });
    expect(saved.objective.varietyWeight).toBe(0);
  });

  it("defaults walk-only fields when there is no base profile", () => {
    const saved = profileFromPlanner(start);
    expect(saved.time.bufferMinutes).toBe(10);
    expect(saved.budget.defaultDurationMinutes).toBeNull();
  });
});

describe("plannerDiffersFromProfile", () => {
  it("is false right after applying, true after a covered setting changes", () => {
    const applied = applyRouteProfile(quickTrads, start);
    expect(plannerDiffersFromProfile(quickTrads, applied)).toBe(false);
    expect(
      plannerDiffersFromProfile(quickTrads, {
        ...applied,
        search: { ...applied.search, terrain: { min: 1, max: 4 } },
      }),
    ).toBe(true);
  });

  it("ignores settings a profile doesn't cover, and list order", () => {
    const applied = applyRouteProfile(
      RouteProfileSettings.parse({
        filters: { types: ["Traditional", "Multi"] },
      }),
      start,
    );
    const profile = profileFromPlanner(applied);
    expect(
      plannerDiffersFromProfile(profile, {
        search: {
          ...applied.search,
          types: ["Multi", "Traditional"],
          radiusM: 12_000,
        },
        plan: { ...applied.plan, topNClusters: 12 },
      }),
    ).toBe(false);
  });
});
