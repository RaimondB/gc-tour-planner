// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { PlanResult } from "@gctp/shared/tours";

import { tourFilename } from "./tour-filename.js";

// Minimal PlanResult — only the fields tourFilename reads.
function plan(over: Partial<PlanResult> = {}): PlanResult {
  return {
    orderedCacheIds: [1, 2, 3],
    totals: { meters: 8345, seconds: 0, visitMinutes: 0 },
    parking: {
      type: "osrm-nearest",
      point: { type: "Point", coordinates: [0, 0] },
      reason: "",
      fallback: false,
    },
    ...over,
  } as PlanResult;
}

const JUN17 = new Date(2026, 5, 17); // local-time constructor → getMonth()/getDate() stable

describe("tourFilename", () => {
  it("builds km-caches-date-mode with no named parking", () => {
    expect(tourFilename(plan(), "track", JUN17)).toBe(
      "gctp-8.3km-3c-Jun17-track.gpx",
    );
  });

  it("trims a whole-number distance and reflects the mode", () => {
    expect(
      tourFilename(
        plan({ totals: { meters: 12000, seconds: 0, visitMinutes: 0 } }),
        "route",
        JUN17,
      ),
    ).toBe("gctp-12km-3c-Jun17-route.gpx");
  });

  it("prepends a slugified OSM parking name when present", () => {
    const p = plan({
      parking: {
        type: "osm",
        point: { type: "Point", coordinates: [0, 0] },
        reason: "",
        fallback: false,
        osm: {
          osmId: 1,
          osmType: "W",
          access: null,
          fee: null,
          name: "Bospark P3",
        },
      },
    });
    expect(tourFilename(p, "track", JUN17)).toBe(
      "gctp-bospark-p3-8.3km-3c-Jun17-track.gpx",
    );
  });

  it("zero-pads the day", () => {
    expect(tourFilename(plan(), "track", new Date(2026, 0, 5))).toBe(
      "gctp-8.3km-3c-Jan05-track.gpx",
    );
  });
});
