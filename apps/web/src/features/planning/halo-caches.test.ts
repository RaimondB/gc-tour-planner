// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import { haloRadiusMeters, mergeCachesById } from "./halo-caches.js";

function cache(id: number, lng = 5.8, lat = 51.8): CacheSummaryDTO {
  return {
    id,
    code: `GC${id}`,
    type: "Traditional",
    name: `cache ${id}`,
    location: { type: "Point", coordinates: [lng, lat] },
    disabled: false,
    solved: false,
    foundByMe: false,
    stageCount: 0,
    parkingPoints: [],
    requiresTool: false,
  } as CacheSummaryDTO;
}

// Regression guard for the boundary-halo render bug (ADR-0026). Discovery can
// place a cluster member in the radiusM…poolRadius halo; the map's base /caches
// query never fetched it, so it had no marker. The fix unions a grown-radius
// page. These pin the union + the radius the second page must use.
describe("mergeCachesById", () => {
  it("includes halo-only members so they can resolve to a marker", () => {
    const base = [cache(1), cache(2)];
    const halo = [cache(2), cache(3) /* halo-only — the bug case */];
    const merged = mergeCachesById(base, halo)!;
    expect(merged.map((c) => c.id).sort()).toEqual([1, 2, 3]);
  });

  it("dedupes by id, keeping the base occurrence", () => {
    const base = [cache(7, 5.0, 51.0)];
    const halo = [cache(7, 9.9, 49.9)];
    const merged = mergeCachesById(base, halo)!;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.location.coordinates).toEqual([5.0, 51.0]);
  });

  it("returns the base reference unchanged when there is no halo yet", () => {
    const base = [cache(1)];
    expect(mergeCachesById(base, undefined)).toBe(base);
    expect(mergeCachesById(base, [])).toBe(base);
  });

  it("handles an empty base (halo arrives first)", () => {
    const halo = [cache(9)];
    expect(mergeCachesById(undefined, halo)).toBe(halo);
  });
});

describe("haloRadiusMeters", () => {
  it("matches the shared API pool radius (no client/server drift)", () => {
    expect(haloRadiusMeters(22500, 8500)).toBe(26750);
  });
});
