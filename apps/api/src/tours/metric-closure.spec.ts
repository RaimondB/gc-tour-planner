// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { metricClosure } from "./metric-closure.js";

describe("metricClosure", () => {
  it("fills a null direct leg with the through-component distance", () => {
    // A=0, B=1, C=2. A↔C have no direct route, but A↔B and B↔C are ≤ maxLink.
    const meters = [
      [0, 300, null],
      [300, 0, 400],
      [null, 400, 0],
    ];
    const { meters: out, filledLegs } = metricClosure(meters, 1000);
    expect(out[0]![2]).toBe(700); // 300 + 400 via B
    expect(out[2]![0]).toBe(700);
    expect(filledLegs).toBe(2);
    // Direct, in-cap legs are untouched.
    expect(out[0]![1]).toBe(300);
    expect(out[1]![2]).toBe(400);
  });

  it("keeps a finite direct leg even when it exceeds maxLinkMeters", () => {
    // A→C direct is a real 5 km route; the closure must not overwrite it with a
    // shorter through-path. Only stepping stones are capped, not kept legs.
    const meters = [
      [0, 300, 5000],
      [300, 0, 400],
      [5000, 400, 0],
    ];
    const { meters: out, filledLegs } = metricClosure(meters, 1000);
    expect(out[0]![2]).toBe(5000); // real direct route preserved
    expect(filledLegs).toBe(0);
  });

  it("leaves a pair null when no ≤maxLink path connects them", () => {
    // B↔C link is 9 km — above the cap — so C is unreachable from A within the
    // graph and its null direct leg stays null.
    const meters = [
      [0, 300, null],
      [300, 0, 9000],
      [null, 9000, 0],
    ];
    const { meters: out, filledLegs } = metricClosure(meters, 1000);
    expect(out[0]![2]).toBeNull();
    expect(filledLegs).toBe(0);
  });

  it("carries seconds along the shortest-metre path for filled legs", () => {
    const meters = [
      [0, 300, null],
      [300, 0, 400],
      [null, 400, 0],
    ];
    const seconds = [
      [0, 250, null],
      [250, 0, 360],
      [null, 360, 0],
    ];
    const { meters: outM, seconds: outS } = metricClosure(
      meters,
      1000,
      seconds,
    );
    expect(outM[0]![2]).toBe(700);
    expect(outS![0]![2]).toBe(610); // 250 + 360 via B
    // Untouched legs keep their original seconds.
    expect(outS![0]![1]).toBe(250);
  });

  it("returns null seconds when no seconds matrix is supplied", () => {
    const { seconds } = metricClosure(
      [
        [0, 300],
        [300, 0],
      ],
      1000,
    );
    expect(seconds).toBeNull();
  });

  it("respects asymmetric (directed) legs", () => {
    // A→B routable, B→A null; the directed shortest paths differ.
    const meters = [
      [0, 200, null],
      [null, 0, 200],
      [200, null, 0],
    ];
    const { meters: out } = metricClosure(meters, 1000);
    expect(out[0]![2]).toBe(400); // A→B→C
    expect(out[1]![0]).toBe(400); // B→C→A
    expect(out[2]![1]).toBe(400); // C→A→B
  });

  it("is a no-op on an already-complete matrix", () => {
    const meters = [
      [0, 100, 200],
      [100, 0, 150],
      [200, 150, 0],
    ];
    const { meters: out, filledLegs } = metricClosure(meters, 1000);
    expect(out).toEqual(meters);
    expect(filledLegs).toBe(0);
  });
});
