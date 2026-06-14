// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { SaveTourInput, TourName } from "./save-tour.js";
import { RenameTourInput } from "./rename-tour.js";
import type { PlanResult } from "./plan-result.js";

const plan: PlanResult = {
  orderedCacheIds: [1, 2],
  droppedCacheIds: [],
  polyline: {
    type: "LineString",
    coordinates: [
      [5.1, 52.0],
      [5.2, 52.1],
    ],
  },
  totals: { meters: 1000, seconds: 600, visitMinutes: 10 },
  parking: {
    type: "user",
    point: { type: "Point", coordinates: [5.1, 52.0] },
    reason: "x",
    fallback: false,
  },
  scoreBreakdown: { a: 1 },
  legs: [],
};

describe("TourName", () => {
  it("trims surrounding whitespace", () => {
    expect(TourName.parse("  Forest loop  ")).toBe("Forest loop");
  });

  it("rejects empty / whitespace-only names", () => {
    expect(TourName.safeParse("").success).toBe(false);
    expect(TourName.safeParse("   ").success).toBe(false);
  });

  it("rejects names longer than 120 chars", () => {
    expect(TourName.safeParse("a".repeat(121)).success).toBe(false);
    expect(TourName.safeParse("a".repeat(120)).success).toBe(true);
  });
});

describe("SaveTourInput", () => {
  it("accepts a name + PlanResult and trims the name", () => {
    const parsed = SaveTourInput.parse({ name: "  Trip ", plan });
    expect(parsed.name).toBe("Trip");
    expect(parsed.plan.orderedCacheIds).toEqual([1, 2]);
  });

  it("rejects a missing plan", () => {
    expect(SaveTourInput.safeParse({ name: "Trip" }).success).toBe(false);
  });
});

describe("RenameTourInput", () => {
  it("enforces the same name rule", () => {
    expect(RenameTourInput.parse({ name: " New " }).name).toBe("New");
    expect(RenameTourInput.safeParse({ name: "" }).success).toBe(false);
  });
});
