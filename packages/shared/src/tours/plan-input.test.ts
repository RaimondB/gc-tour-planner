// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PlanInput } from "./plan-input.js";

describe("PlanInput", () => {
  it("applies defaults for maxCaches, distanceBudgetMeters, startPreference", () => {
    const parsed = PlanInput.parse({
      center: [5.12, 52.09],
      radiusM: 5000,
      hardFilters: {},
      softPreferences: {},
    });

    expect(parsed.maxCaches).toBe(15);
    expect(parsed.distanceBudgetMeters).toBe(8_000);
    expect(parsed.startPreference).toBe("auto");
    expect(parsed.softPreferences.clusterDensityWeight).toBe(1);
    expect(parsed.softPreferences.loopCompactnessWeight).toBe(1);
  });

  it("rejects an out-of-range center", () => {
    expect(() =>
      PlanInput.parse({
        center: [200, 100],
        radiusM: 1000,
        hardFilters: {},
        softPreferences: {},
      }),
    ).toThrow();
  });

  it("rejects a radius beyond 50 km", () => {
    expect(() =>
      PlanInput.parse({
        center: [5.12, 52.09],
        radiusM: 60_000,
        hardFilters: {},
        softPreferences: {},
      }),
    ).toThrow();
  });

  // Regression for the zod 4 bump (cluster 4): our seed landuseProfileIds are
  // all-same-digit placeholders (e.g. 33333333-…) whose RFC 9562 version +
  // variant nibbles are invalid. zod 4's z.uuid() rejects those; we use the
  // loose z.guid() (= zod 3's old z.string().uuid()) so they keep validating.
  it("accepts a non-RFC-variant (seed) landuseProfileId", () => {
    const parsed = PlanInput.parse({
      center: [5.12, 52.09],
      radiusM: 5000,
      hardFilters: {},
      softPreferences: {
        landuseProfileId: "33333333-3333-3333-3333-333333333333",
      },
    });

    expect(parsed.softPreferences.landuseProfileId).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });
});
