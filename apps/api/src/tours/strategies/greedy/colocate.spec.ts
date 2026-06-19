// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { collapseColocated } from "./colocate.js";

// 4 caches: 10 & 11 are ~5 m apart (one Adventure Lab), 20 & 21 are far from
// everything. Distances are walking metres (symmetric here).
const IDS = [10, 11, 20, 21];
const D = [
  [0, 5, 800, 900],
  [5, 0, 790, 880],
  [800, 790, 0, 600],
  [900, 880, 600, 0],
];
// stage_sequence: 11 is stage 1, 10 is stage 2 (so the group reps to 11).
const seq = (id: number) =>
  id === 11 ? 1 : id === 10 ? 2 : Number.POSITIVE_INFINITY;

describe("collapseColocated", () => {
  it("merges caches within the threshold into one group, rep = lowest order-key", () => {
    const g = collapseColocated(IDS, D, seq, 40);
    expect(g.repIds.length).toBe(3); // {10,11} merged; 20, 21 separate
    // 11 (stage 1) represents the merged group and members are stage-ordered.
    expect(g.members.get(11)).toEqual([11, 10]);
    expect(g.members.get(20)).toEqual([20]);
    expect(g.members.get(21)).toEqual([21]);
    // Reduced matrix is square over reps, 0 on the diagonal.
    expect(g.repDistances.length).toBe(3);
    g.repDistances.forEach((row, i) => expect(row[i]).toBe(0));
  });

  it("threshold 0 disables merging (every cache its own group)", () => {
    const g = collapseColocated(IDS, D, seq, 0);
    expect(g.repIds.length).toBe(4);
    expect(g.members.get(10)).toEqual([10]);
  });

  it("does not merge across a null (unreachable) distance", () => {
    const d = [
      [0, null, 800, 900],
      [null, 0, 790, 880],
      [800, 790, 0, 600],
      [900, 880, 600, 0],
    ];
    const g = collapseColocated(IDS, d, seq, 40);
    expect(g.repIds.length).toBe(4); // 10/11 not merged — distance unknown
  });
});
