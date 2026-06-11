// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { DRAG_CLICK_THRESHOLD_PX, isDragGesture } from "./pointer-drag.js";

describe("isDragGesture", () => {
  it("treats a missing down-point as a click", () => {
    expect(isDragGesture(null, { x: 100, y: 100 })).toBe(false);
  });

  it("treats a stationary tap as a click", () => {
    expect(isDragGesture({ x: 50, y: 50 }, { x: 50, y: 50 })).toBe(false);
  });

  it("allows small jitter under the threshold", () => {
    expect(isDragGesture({ x: 50, y: 50 }, { x: 53, y: 53 })).toBe(false); // ~4.2px
  });

  it("flags movement beyond the threshold as a drag", () => {
    expect(isDragGesture({ x: 0, y: 0 }, { x: 0, y: 20 })).toBe(true);
  });

  it("uses Euclidean distance, not per-axis", () => {
    // 5px on each axis = ~7.07px > 6px default threshold.
    expect(isDragGesture({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true);
  });

  it("respects a custom threshold", () => {
    const up = { x: 0, y: 10 };
    expect(isDragGesture({ x: 0, y: 0 }, up, 4)).toBe(true);
    expect(isDragGesture({ x: 0, y: 0 }, up, 20)).toBe(false);
  });

  it("exports a sane default threshold", () => {
    expect(DRAG_CLICK_THRESHOLD_PX).toBeGreaterThan(0);
  });
});
