// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { Caches } from "@gctp/shared";
import {
  collapseAdventures,
  expandAdventureIds,
} from "./collapse-adventures.js";

function cache(
  id: number,
  lng: number,
  lat: number,
  opts: { type?: string; adventureId?: string | null } = {},
): Caches.CacheDTO {
  return {
    id,
    type: opts.type ?? "Traditional",
    adventureId: opts.adventureId ?? null,
    location: { type: "Point", coordinates: [lng, lat] },
  } as unknown as Caches.CacheDTO;
}

function al(id: number, lng: number, lat: number, adventureId: string) {
  return cache(id, lng, lat, { type: "Adventure Lab", adventureId });
}

describe("collapseAdventures", () => {
  it("is a no-op when there are no Adventure Labs", () => {
    const caches = [cache(1, 5, 52), cache(2, 5.01, 52)];
    const { collapsed, expansion } = collapseAdventures(caches);
    expect(collapsed).toHaveLength(2);
    expect(expansion.size).toBe(0);
  });

  it("collapses each adventure's stages to one representative near its centroid", () => {
    // Adventure A: 3 stages around (5.00, 52.00); medoid is the middle one (id 11).
    const caches = [
      cache(1, 4.0, 52.0), // plain
      al(10, 5.0, 52.0, "A"),
      al(11, 5.001, 52.0, "A"), // nearest the centroid (~5.001)
      al(12, 5.002, 52.0, "A"),
    ];
    const { collapsed, expansion } = collapseAdventures(caches);

    // One plain cache + one representative for adventure A.
    expect(collapsed.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 11]);
    expect(expansion.size).toBe(1);
    // The representative expands back to all three stages, ascending.
    expect(expansion.get(11)).toEqual([10, 11, 12]);
  });

  it("keeps distinct adventures as separate representatives", () => {
    const caches = [
      al(10, 5.0, 52.0, "A"),
      al(11, 5.001, 52.0, "A"),
      al(20, 6.0, 52.0, "B"),
      al(21, 6.001, 52.0, "B"),
    ];
    const { collapsed, expansion } = collapseAdventures(caches);
    expect(collapsed).toHaveLength(2);
    expect(expansion.size).toBe(2);
    const allMembers = [...expansion.values()].flat().sort((a, b) => a - b);
    expect(allMembers).toEqual([10, 11, 20, 21]);
  });

  it("leaves a single-stage adventure as its own node with no expansion entry", () => {
    const caches = [cache(1, 5, 52), al(10, 5.5, 52, "A")];
    const { collapsed, expansion } = collapseAdventures(caches);
    expect(collapsed.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 10]);
    expect(expansion.size).toBe(0);
  });

  it("breaks medoid ties deterministically on the lowest id", () => {
    // Two co-located stages: both sit exactly on the centroid (distance 0), so
    // the tie breaks on the lowest id.
    const caches = [al(20, 5.0, 52.0, "A"), al(10, 5.0, 52.0, "A")];
    const { collapsed } = collapseAdventures(caches);
    expect(collapsed.map((c) => c.id)).toEqual([10]);
  });
});

describe("expandAdventureIds", () => {
  it("replaces representative ids inline and passes others through", () => {
    const expansion = new Map<number, number[]>([[11, [10, 11, 12]]]);
    expect(expandAdventureIds([1, 11, 2], expansion)).toEqual([
      1, 10, 11, 12, 2,
    ]);
  });

  it("returns the input unchanged when nothing maps", () => {
    expect(expandAdventureIds([1, 2, 3], new Map())).toEqual([1, 2, 3]);
  });
});
