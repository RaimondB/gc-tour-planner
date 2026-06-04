// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { toCacheSummary, type CacheDTO } from "./index.js";

const base: CacheDTO = {
  id: 1,
  source: "gpx",
  sourceId: "GC1",
  code: "GC1",
  type: "Traditional",
  name: "Forest Walk",
  location: { type: "Point", coordinates: [5.12, 52.09] },
  difficulty: 1.5,
  terrain: 2,
  size: "Small",
  archived: false,
  disabled: false,
  attributeIds: [],
  parkingPoints: [[5.123, 52.092]],
  foundByMe: false,
  stageCount: 0,
  descriptionHints: [],
};

describe("toCacheSummary", () => {
  it("keeps map fields and drops popup-only fields", () => {
    const s = toCacheSummary(base);
    expect(s).toEqual({
      id: 1,
      code: "GC1",
      type: "Traditional",
      name: "Forest Walk",
      location: { type: "Point", coordinates: [5.12, 52.09] },
      disabled: false,
      foundByMe: false,
      stageCount: 0,
      parkingPoints: [[5.123, 52.092]],
      requiresTool: false,
    });
    // The heavy/popup-only fields must not leak onto the wire shape.
    expect("attributeIds" in s).toBe(false);
    expect("descriptionHints" in s).toBe(false);
    expect("difficulty" in s).toBe(false);
  });

  it("sets requiresTool from a tool attribute id (id 51)", () => {
    expect(toCacheSummary({ ...base, attributeIds: [51] }).requiresTool).toBe(
      true,
    );
  });

  it("sets requiresTool from a non-empty descriptionHints", () => {
    expect(
      toCacheSummary({ ...base, descriptionHints: ["fishingRod"] })
        .requiresTool,
    ).toBe(true);
  });
});
