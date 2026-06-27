// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { advanceFollow } from "./follow.js";

// Three stops ~685 m apart (0.01° lng at lat 52) — well outside the 30 m arrive
// radius, so only the exact stop counts as "reached".
const stops: [number, number][] = [
  [5.0, 52.0],
  [5.01, 52.0],
  [5.02, 52.0],
];

describe("advanceFollow", () => {
  it("targets the first stop when far from all of them", () => {
    const s = advanceFollow(stops, [4.0, 51.0], new Set());
    expect(s.targetIndex).toBe(0);
    expect([...s.visited]).toEqual([]);
  });

  it("marks the stop you've arrived at and advances to the next", () => {
    const s = advanceFollow(stops, [5.0, 52.0], new Set());
    expect(s.visited.has(0)).toBe(true);
    expect(s.targetIndex).toBe(1);
  });

  it("keeps prior progress and completes when the last stop is reached", () => {
    const s = advanceFollow(stops, [5.02, 52.0], new Set([0, 1]));
    expect([...s.visited].sort()).toEqual([0, 1, 2]);
    expect(s.targetIndex).toBe(-1); // all done
  });

  it("respects plan order — a manually-skipped middle stop doesn't become the target", () => {
    const s = advanceFollow(stops, [4.0, 51.0], new Set([1]));
    expect(s.targetIndex).toBe(0);
  });

  it("is idempotent — re-running with the returned set changes nothing", () => {
    const first = advanceFollow(stops, [5.0, 52.0], new Set());
    const second = advanceFollow(stops, [5.0, 52.0], first.visited);
    expect([...second.visited].sort()).toEqual([...first.visited].sort());
    expect(second.targetIndex).toBe(first.targetIndex);
  });
});
