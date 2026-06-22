// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { coverCircle } from "./cover-circle.js";

const CENTER: [number, number] = [5.0, 52.0];
// ~1 km east of CENTER at lat 52 (1° lng ≈ 68.5 km, so 0.0146° ≈ 1 km).
const near: [number, number] = [5.0146, 52.0];
// ~12 km east — well outside a 5 km circle.
const far: [number, number] = [5.176, 52.0];

describe("coverCircle", () => {
  it("returns null for no coords", () => {
    expect(
      coverCircle([], { center: CENTER, radiusM: 5000 }, { recenter: false }),
    ).toBeNull();
  });

  it("grow-only: returns null when coords already fit", () => {
    expect(
      coverCircle(
        [near],
        { center: CENTER, radiusM: 5000 },
        { recenter: false },
      ),
    ).toBeNull();
  });

  it("grow-only: grows the radius to enclose an out-of-circle coord, keeps center", () => {
    const out = coverCircle(
      [far],
      { center: CENTER, radiusM: 5000 },
      { recenter: false },
    );
    expect(out).not.toBeNull();
    expect(out!.center).toEqual(CENTER); // center unchanged
    expect(out!.radiusM).toBeGreaterThan(5000);
    // ~12 km + 12% margin ⇒ ~13.4 km.
    expect(out!.radiusM).toBeGreaterThan(12_000);
  });

  it("grow-only: never shrinks", () => {
    expect(
      coverCircle(
        [near],
        { center: CENTER, radiusM: 20_000 },
        { recenter: false },
      ),
    ).toBeNull();
  });

  it("recenter: moves the center to the coords' bbox and sizes to enclose", () => {
    // A small cluster ~12 km away from the current center.
    const a: [number, number] = [5.17, 52.0];
    const b: [number, number] = [5.18, 52.0];
    const out = coverCircle(
      [a, b],
      { center: CENTER, radiusM: 8000 },
      { recenter: true },
    );
    expect(out).not.toBeNull();
    expect(out!.center[0]).toBeCloseTo(5.175, 3); // bbox center lng
    expect(out!.center[1]).toBeCloseTo(52.0, 3);
    // Tight pair ⇒ radius hits the 500 m floor, not the old 8 km.
    expect(out!.radiusM).toBe(500);
  });

  it("recenter: returns null when already centered + sized", () => {
    // Two points straddling CENTER (±1 km) ⇒ bbox center == CENTER, covering
    // radius ≈ 1.12 km; a circle already there + sized needs no change.
    const west: [number, number] = [4.9854, 52.0];
    expect(
      coverCircle(
        [near, west],
        { center: CENTER, radiusM: 1120 },
        { recenter: true },
      ),
    ).toBeNull();
  });

  it("clamps the radius to 50 km", () => {
    const veryFar: [number, number] = [6.5, 52.0]; // ~100 km east
    const out = coverCircle(
      [veryFar],
      { center: CENTER, radiusM: 5000 },
      { recenter: false },
    );
    expect(out!.radiusM).toBe(50_000);
  });
});
