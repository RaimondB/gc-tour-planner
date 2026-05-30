// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  attributeById,
  classifyMulti,
  GC_ATTRIBUTES,
  hasToolRequirement,
  isMiniMulti,
  MULTI_MINI_MAX_STAGES,
  TOOL_ATTRIBUTE_IDS,
} from "./attributes.js";

describe("GC_ATTRIBUTES curated lookup", () => {
  it("contains the empirically verified tool attribute ids", () => {
    // Source-of-truth: a `gunzip | grep` over the user's stored PQs.
    // Update this list when extending the curated set.
    const expected = [3, 4, 5, 11, 12, 44, 48, 49, 50, 51, 64];
    expect([...TOOL_ATTRIBUTE_IDS].sort((a, b) => a - b)).toEqual(expected);
  });

  it("has unique ids", () => {
    const seen = new Set<number>();
    for (const a of GC_ATTRIBUTES) {
      expect(seen.has(a.id), `duplicate id ${a.id}`).toBe(false);
      seen.add(a.id);
    }
  });

  it("attributeById returns metadata for known ids and undefined for unknown", () => {
    expect(attributeById(51)?.name).toBe("Special tool required");
    expect(attributeById(51)?.isTool).toBe(true);
    expect(attributeById(64)?.name).toBe("Tree climbing required");
    expect(attributeById(64)?.isTool).toBe(true);
    expect(attributeById(1)?.isTool).toBe(false);
    expect(attributeById(9999)).toBeUndefined();
  });
});

describe("hasToolRequirement", () => {
  it("returns true when any attribute id is a tool id", () => {
    expect(hasToolRequirement([51])).toBe(true);
    expect(hasToolRequirement([1, 25, 51])).toBe(true);
    expect(hasToolRequirement([64])).toBe(true);
  });

  it("returns false for attribute-only sets that contain no tool ids", () => {
    expect(hasToolRequirement([])).toBe(false);
    expect(hasToolRequirement([1, 25, 27])).toBe(false);
  });

  it("returns true when descriptionHints is non-empty even with no tool attrs", () => {
    expect(hasToolRequirement([], ["fishingRod"])).toBe(true);
    expect(hasToolRequirement([1, 25], ["mirror"])).toBe(true);
  });

  it("returns false when descriptionHints is undefined or empty and no tool attrs", () => {
    expect(hasToolRequirement([1, 25], [])).toBe(false);
    expect(hasToolRequirement([1, 25], undefined)).toBe(false);
  });
});

describe("classifyMulti / isMiniMulti", () => {
  it("classifies 0 stages as field-puzzle (not mini)", () => {
    expect(classifyMulti(0)).toBe("field-puzzle");
    // Critical: isMiniMulti(0) must NOT be true — that would bucket
    // field-puzzle multis with quick-hop minis and break the filter.
    expect(isMiniMulti(0)).toBe(false);
  });

  it("classifies 1..MULTI_MINI_MAX_STAGES as mini", () => {
    for (let i = 1; i <= MULTI_MINI_MAX_STAGES; i += 1) {
      expect(classifyMulti(i), `stageCount=${i}`).toBe("mini");
      expect(isMiniMulti(i)).toBe(true);
    }
  });

  it("classifies counts above the threshold as full", () => {
    expect(classifyMulti(MULTI_MINI_MAX_STAGES + 1)).toBe("full");
    expect(classifyMulti(10)).toBe("full");
    expect(isMiniMulti(10)).toBe(false);
  });
});
