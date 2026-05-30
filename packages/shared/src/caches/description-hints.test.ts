// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  descriptionHintByKey,
  DESCRIPTION_HINTS,
  scanDescriptionHints,
} from "./description-hints.js";

describe("scanDescriptionHints", () => {
  it("returns empty array for empty / whitespace input", () => {
    expect(scanDescriptionHints("")).toEqual([]);
    expect(scanDescriptionHints("   \n  ")).toEqual([]);
  });

  it("matches English fishing keywords", () => {
    expect(scanDescriptionHints("Bring a fishing rod")).toContain("fishingRod");
    expect(scanDescriptionHints("This is for the angler")).toContain(
      "fishingRod",
    );
    expect(scanDescriptionHints("you'll need a fishing-pole")).toContain(
      "fishingRod",
    );
  });

  it("matches Dutch fishing keywords (hengel / vishengel / visstok)", () => {
    expect(scanDescriptionHints("Vergeet je hengel niet")).toContain(
      "fishingRod",
    );
    expect(scanDescriptionHints("Een vishengel is handig")).toContain(
      "fishingRod",
    );
    expect(scanDescriptionHints("Visstok meenemen")).toContain("fishingRod");
  });

  it("matches German fishing compounds (Angelrute) but not bare 'Angel'", () => {
    expect(scanDescriptionHints("Bitte Angelrute mitbringen")).toContain(
      "fishingRod",
    );
    // "Angel" alone is ambiguous (e.g. "Angel of the East") — must
    // NOT match, by design.
    expect(scanDescriptionHints("This is an angel of mercy")).not.toContain(
      "fishingRod",
    );
  });

  it("matches multiple hint families in a single description, in dictionary order", () => {
    const text =
      "You'll need binoculars, a magnet, tweezers, a ladder, and possibly a mirror.";
    const hits = scanDescriptionHints(text);
    expect(hits).toEqual([
      // Dictionary order, not text order — see DESCRIPTION_HINTS.
      "binoculars",
      "magnet",
      "tweezers",
      "ladder",
      "mirror",
    ]);
  });

  it("does not double-count a hint when multiple keywords match", () => {
    // Magnet/magnetic should both match the same hint but appear once.
    const hits = scanDescriptionHints("A magnetic magnet is useful");
    expect(hits.filter((h) => h === "magnet")).toHaveLength(1);
  });

  it("scans across multilingual mixed descriptions", () => {
    const text =
      "Take your verrekijker for the view, and bring a Magnet for the gizmo.";
    expect(scanDescriptionHints(text).sort()).toEqual(
      ["binoculars", "magnet"].sort(),
    );
  });
});

describe("descriptionHintByKey", () => {
  it("returns metadata for every key in the dictionary", () => {
    for (const hint of DESCRIPTION_HINTS) {
      expect(descriptionHintByKey(hint.key)?.label).toBe(hint.label);
    }
  });

  it("returns undefined for unknown keys", () => {
    expect(descriptionHintByKey("notARealKey")).toBeUndefined();
  });
});
