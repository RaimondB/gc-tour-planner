// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ShareResponse, SharedTour } from "./shared-tour.js";

const valid = {
  name: "Forest loop",
  totals: { meters: 4200, seconds: 3100, visitMinutes: 25 },
  polyline: {
    type: "LineString",
    coordinates: [
      [5.1, 52.0],
      [5.11, 52.01],
      [5.1, 52.0],
    ],
  },
  parking: { type: "Point", coordinates: [5.1, 52.0] },
  caches: [
    {
      id: 1,
      code: "GC123",
      type: "Traditional",
      name: "By the bridge",
      location: { type: "Point", coordinates: [5.1, 52.0] },
    },
  ],
};

describe("SharedTour (public payload contract, ADR-0022)", () => {
  it("parses the safe public subset", () => {
    const parsed = SharedTour.parse(valid);
    expect(parsed.name).toBe("Forest loop");
    expect(parsed.caches).toHaveLength(1);
    expect(parsed.totals.meters).toBe(4200);
  });

  it("allows a null parking point (centroid fallback)", () => {
    expect(() => SharedTour.parse({ ...valid, parking: null })).not.toThrow();
  });

  it("strips owner identity / score breakdown if they ever leak in", () => {
    const parsed = SharedTour.parse({
      ...valid,
      ownerId: "11111111-1111-1111-1111-111111111111",
      scoreBreakdown: { density: 0.9 },
      legs: [{ index: 0 }],
      droppedCaches: [{ id: 9, reason: "budget" }],
    });
    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed).not.toHaveProperty("scoreBreakdown");
    expect(parsed).not.toHaveProperty("legs");
    expect(parsed).not.toHaveProperty("droppedCaches");
  });
});

describe("ShareResponse", () => {
  it("carries the slug + client-relative path", () => {
    const parsed = ShareResponse.parse({
      slug: "abc23",
      path: "/shared/abc23",
    });
    expect(parsed.path).toBe("/shared/abc23");
  });
});
