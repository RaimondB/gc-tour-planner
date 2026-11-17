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

/** Every field away from its default, so a dropped mapping can't hide. */
const custom = RouteProfileSettings.parse({
  search: { radiusM: 12_000 },
  filters: {
    types: ["Traditional", "Multi"],
    multiSubtype: "mini",
    excludeFound: true,
    includeDisabled: true,
    hideToolCaches: true,
    solvedMysteriesOnly: true,
    contexts: ["forest", "park"],
    difficulty: { min: 1.5, max: 3 },
    terrain: { min: 2, max: 4.5 },
    excludeSavedTourCaches: false,
  },
  adventures: { include: false, keepTogether: false, interleave: false },
  objective: {
    landuseProfileId: "11111111-1111-1111-1111-111111111111",
    landuseWeight: 3,
    centerProximityWeight: 0.5,
    varietyWeight: 2,
    preferredTypes: ["Mystery"],
    preferredWeight: 4,
  },
  time: {
    visitMinutes: 8,
    visitMinutesByType: { Multi: 20, Mystery: 15 },
    alStageVisitMinutes: 3,
    toolBonusMinutes: 10,
    walkingKmh: 4.5,
  },
  budget: {
    distanceBudgetMeters: 6_500,
    durationMinutes: 150,
    bufferMinutes: 20,
  },
  parking: {
    startPreference: "osm-parking",
    osmAccess: ["yes", "permit"],
    osmFee: "free",
  },
  advanced: {
    minClusterSize: 5,
    maxLinkMeters: 900,
    clusteringStrategy: "leiden",
    topNClusters: 9,
    fringeTrimMeters: 800,
  },
});

const defaults = { search: DEFAULT_SEARCH, plan: DEFAULT_PLAN_SETTINGS };

describe("profile ↔ planner mapping", () => {
  it("planner defaults are exactly the profile defaults", () => {
    expect(profileFromPlanner(defaults)).toEqual(
      RouteProfileSettings.parse({}),
    );
  });

  it("round-trips every profile field through the planner", () => {
    expect(profileFromPlanner(applyRouteProfile(custom, defaults))).toEqual(
      custom,
    );
  });

  it("leaves the search centre and display toggles alone", () => {
    const state = {
      search: {
        ...DEFAULT_SEARCH,
        center: [4.9, 52.37] as [number, number],
        showLanduse: true,
      },
      plan: { ...DEFAULT_PLAN_SETTINGS, showSavedTours: false },
    };
    const { search, plan } = applyRouteProfile(custom, state);
    expect(search.center).toEqual([4.9, 52.37]);
    expect(search.showLanduse).toBe(true);
    expect(plan.showSavedTours).toBe(false);
  });
});

describe("plannerDiffersFromProfile", () => {
  it("is false right after applying, true after any profile setting changes", () => {
    const applied = applyRouteProfile(custom, defaults);
    expect(plannerDiffersFromProfile(custom, applied)).toBe(false);
    expect(
      plannerDiffersFromProfile(custom, {
        ...applied,
        plan: { ...applied.plan, topNClusters: 3 },
      }),
    ).toBe(true);
  });

  it("ignores list/key order and the centre and display toggles", () => {
    const applied = applyRouteProfile(custom, defaults);
    expect(
      plannerDiffersFromProfile(custom, {
        search: {
          ...applied.search,
          types: ["Multi", "Traditional"],
          center: [6, 51],
          showLanduse: true,
        },
        plan: {
          ...applied.plan,
          visitMinutesByType: { Mystery: 15, Multi: 20 },
          showSavedTours: false,
        },
      }),
    ).toBe(false);
  });
});
