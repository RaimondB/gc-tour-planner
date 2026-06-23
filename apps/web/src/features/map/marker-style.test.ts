// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { CACHE_TYPES } from "@gctp/shared/caches";
import {
  TYPE_COLORS,
  TYPE_GLYPH,
  markerImageId,
  cornerIconOffset,
  cornerTextOffset,
} from "./marker-style.js";

describe("TYPE_COLORS palette", () => {
  it("defines a colour for every cache type", () => {
    for (const t of CACHE_TYPES) {
      expect(TYPE_COLORS[t]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("has NO duplicate hex (ADR-0035: Traditional/CITO must differ)", () => {
    const hexes = CACHE_TYPES.map((t) => TYPE_COLORS[t].toLowerCase());
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  it("keeps Adventure Lab purple distinct from Letterbox", () => {
    expect(TYPE_COLORS["Adventure Lab"]).not.toBe(TYPE_COLORS.Letterbox);
  });
});

describe("TYPE_GLYPH", () => {
  it("defines a single-character glyph for every cache type", () => {
    for (const t of CACHE_TYPES) {
      expect(TYPE_GLYPH[t]).toHaveLength(1);
    }
  });
});

describe("markerImageId", () => {
  it("is stable and keyed by kind + colour", () => {
    expect(markerImageId("al", "#7b1fa2")).toBe("gctp-mk-al-7b1fa2");
    expect(markerImageId("cache", "#1565c0")).toBe("gctp-mk-cache-1565c0");
    expect(markerImageId("cache", "#1565c0")).toBe(
      markerImageId("cache", "#1565c0"),
    );
  });
});

describe("corner offsets", () => {
  it("places icons in the correct quadrant (x right, y down)", () => {
    expect(cornerIconOffset("TR")).toEqual([11, -11]);
    expect(cornerIconOffset("TL")).toEqual([-11, -11]);
    expect(cornerIconOffset("BL")).toEqual([-11, 11]);
    expect(cornerIconOffset("BR")).toEqual([11, 11]);
  });

  it("scales text offsets the same way", () => {
    expect(cornerTextOffset("BR")).toEqual([0.9, 0.9]);
    expect(cornerTextOffset("TL")).toEqual([-0.9, -0.9]);
  });
});
