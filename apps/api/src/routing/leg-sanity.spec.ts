// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  HIGH_DETOUR_REJECT,
  MAX_WALKING_MS,
  MIN_WALKING_MS,
  isImpossibleDetour,
  isImpossibleSpeed,
} from "./leg-sanity.js";

describe("isImpossibleSpeed", () => {
  it("accepts a normal walking pace (5 km/h)", () => {
    // 1000 m / 720 s ≈ 1.39 m/s — typical hike pace.
    expect(isImpossibleSpeed(1000, 720)).toBe(false);
  });

  it("accepts brisk walking just under the max threshold", () => {
    // Just below 28 km/h: 1000 m / (1000 / (MAX - 0.01)) seconds.
    const seconds = 1000 / (MAX_WALKING_MS - 0.01);
    expect(isImpossibleSpeed(1000, seconds)).toBe(false);
  });

  it("rejects speeds above the max threshold (car-speed leak)", () => {
    // Sub-30s for a kilometre — unambiguously car speed.
    expect(isImpossibleSpeed(1000, 30)).toBe(true);
  });

  it("rejects speeds below the min threshold (snap artefact)", () => {
    // 12 m taking 10 minutes (1.2 m / minute) is impossible walking.
    expect(isImpossibleSpeed(12, 600)).toBe(true);
  });

  it("rejects non-zero distance with zero duration", () => {
    expect(isImpossibleSpeed(100, 0)).toBe(true);
  });

  it("accepts zero distance (handled upstream)", () => {
    // The zero-distance suspicious guard is the one that catches these.
    expect(isImpossibleSpeed(0, 0)).toBe(false);
    expect(isImpossibleSpeed(0, 10)).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isImpossibleSpeed(Number.NaN, 100)).toBe(true);
    expect(isImpossibleSpeed(100, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("min threshold rounds the expected way", () => {
    // Exactly at MIN: should not be flagged.
    const seconds = 100 / MIN_WALKING_MS;
    expect(isImpossibleSpeed(100, seconds)).toBe(false);
  });
});

describe("isImpossibleDetour", () => {
  it("accepts healthy urban routes (ratio ~1.4)", () => {
    expect(isImpossibleDetour(1400, 1000)).toBe(false);
  });

  it("rejects ratios above the reject threshold", () => {
    expect(isImpossibleDetour(HIGH_DETOUR_REJECT * 1000 + 1, 1000)).toBe(true);
  });

  it("accepts ratios at exactly the reject threshold", () => {
    expect(isImpossibleDetour(HIGH_DETOUR_REJECT * 1000, 1000)).toBe(false);
  });

  it("ignores small haversines where the ratio is meaningless", () => {
    // Co-located stages: 5 m apart, OSRM walked 200 m around a building.
    expect(isImpossibleDetour(200, 5)).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isImpossibleDetour(Number.NaN, 100)).toBe(true);
    expect(isImpossibleDetour(100, Number.NaN)).toBe(true);
  });
});
