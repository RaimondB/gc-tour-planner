// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  clusterGrowthMarginMeters,
  clusterPoolRadiusMeters,
} from "./cluster-growth.js";

// Regression guard for the boundary-halo render bug (ADR-0026): the API grows
// its discovery pool to clusterPoolRadiusMeters(...), and the web client must
// fetch caches out to the SAME radius or an edge cluster's members have no
// marker. Both sides call these functions, so pinning the formula here keeps
// them from silently diverging.
describe("clusterGrowthMarginMeters", () => {
  it("is half the distance budget, floored", () => {
    expect(clusterGrowthMarginMeters(8500)).toBe(4250);
    expect(clusterGrowthMarginMeters(8001)).toBe(4000); // floor, not round
  });

  it("is zero for a non-positive or non-finite budget", () => {
    expect(clusterGrowthMarginMeters(0)).toBe(0);
    expect(clusterGrowthMarginMeters(-100)).toBe(0);
    expect(clusterGrowthMarginMeters(Number.NaN)).toBe(0);
    expect(clusterGrowthMarginMeters(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("clusterPoolRadiusMeters", () => {
  it("extends the search radius by the growth margin", () => {
    // The reported bug: radius 22500 + budget 8500 → pool reaches 26750, but the
    // map fetched only 22500, so the 22500–26750 halo members went unrendered.
    expect(clusterPoolRadiusMeters(22500, 8500)).toBe(26750);
  });

  it("never shrinks below the search radius", () => {
    expect(clusterPoolRadiusMeters(5000, 0)).toBe(5000);
    expect(clusterPoolRadiusMeters(5000, 8000)).toBeGreaterThanOrEqual(5000);
  });
});
