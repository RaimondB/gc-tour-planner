// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { Routing } from "@gctp/shared";
import {
  largestConnectedComponent,
  partitionAdventuresByReachability,
  type CandidateAdventure,
} from "./adventure-cohesion.js";

/**
 * Build a symmetric Routing.Matrix from an id list and an undirected
 * `{ "a-b": meters }` edge map. Unlisted off-diagonal pairs are `null`
 * (unrouteable), so only explicit edges can carry the BFS.
 */
function matrixOf(
  ids: number[],
  edges: Record<string, number>,
): Routing.Matrix {
  const meters = (a: number, b: number): number | null => {
    if (a === b) return 0;
    const v = edges[`${a}-${b}`] ?? edges[`${b}-${a}`];
    return v ?? null;
  };
  return {
    profile: "foot",
    cacheIds: ids,
    legs: ids.map((a) =>
      ids.map((b) => {
        const m = meters(a, b);
        return m === null ? null : { meters: m, seconds: m };
      }),
    ),
  };
}

describe("partitionAdventuresByReachability", () => {
  const seedIds = [1, 2];
  const candidates: CandidateAdventure[] = [
    { adventureId: "A", stageIds: [10, 11] }, // both near the seed
    { adventureId: "B", stageIds: [20, 21] }, // across a barrier
    { adventureId: "C", stageIds: [30, 31] }, // 31 chains through 30
  ];
  const ids = [1, 2, 10, 11, 20, 21, 30, 31];
  const edges: Record<string, number> = {
    "1-2": 500,
    "1-10": 800, // seed → A
    "10-11": 300, // within A
    "1-30": 900, // seed → C (stage 30)
    "30-31": 400, // 31 reachable only via 30
    "20-21": 300, // B's stages are near each other…
    // …but nothing links {seed, A, C} to 20/21 within range → B is stranded.
  };

  it("accepts adventures whose every stage connects within maxLinkMeters", () => {
    const out = partitionAdventuresByReachability({
      seedIds,
      candidates,
      matrix: matrixOf(ids, edges),
      maxLinkMeters: 1000,
    });
    // A and C accepted; B rejected whole.
    expect(out.acceptedStageIds.sort((a, b) => a - b)).toEqual([
      10, 11, 30, 31,
    ]);
    expect(out.rejected).toEqual([{ adventureId: "B", stageIds: [20, 21] }]);
  });

  it("rejects a whole adventure when one stage is across a barrier", () => {
    // Move A's link out of range: 1→10 becomes 1500 > 1000. 11 only chains via
    // 10, so the whole of A now strands.
    const out = partitionAdventuresByReachability({
      seedIds,
      candidates,
      matrix: matrixOf(ids, { ...edges, "1-10": 1500 }),
      maxLinkMeters: 1000,
    });
    expect(out.acceptedStageIds.sort((a, b) => a - b)).toEqual([30, 31]);
    expect(out.rejected.map((r) => r.adventureId).sort()).toEqual(["A", "B"]);
  });

  it("treats ids missing from the matrix as unreachable", () => {
    const out = partitionAdventuresByReachability({
      seedIds,
      candidates: [{ adventureId: "Z", stageIds: [999] }],
      matrix: matrixOf(ids, edges),
      maxLinkMeters: 100_000,
    });
    expect(out.acceptedStageIds).toEqual([]);
    expect(out.rejected).toEqual([{ adventureId: "Z", stageIds: [999] }]);
  });
});

describe("largestConnectedComponent", () => {
  // ids-indexed meters matrix from an undirected edge map; unlisted pairs null.
  const mtx = (
    ids: number[],
    edges: Record<string, number>,
  ): (number | null)[][] =>
    ids.map((a) =>
      ids.map((b) => {
        if (a === b) return 0;
        return edges[`${a}-${b}`] ?? edges[`${b}-${a}`] ?? null;
      }),
    );

  it("keeps the larger of two components split by a >maxLink gap", () => {
    // {1,2,3} chained ≤1000; {4,5} chained ≤1000; the only 3↔4 link is 5000.
    const ids = [1, 2, 3, 4, 5];
    const edges = { "1-2": 400, "2-3": 400, "4-5": 400, "3-4": 5000 };
    const out = largestConnectedComponent(ids, mtx(ids, edges), 1000);
    expect(out.keptIds).toEqual([1, 2, 3]);
    expect(out.droppedIds).toEqual([4, 5]);
  });

  it("splits on null (unrouteable) legs too", () => {
    const ids = [1, 2, 3];
    // 3 is unrouteable to everyone (all null); 1↔2 connected.
    const out = largestConnectedComponent(ids, mtx(ids, { "1-2": 300 }), 1500);
    expect(out.keptIds).toEqual([1, 2]);
    expect(out.droppedIds).toEqual([3]);
  });

  it("keeps everything when the set is one component", () => {
    const ids = [1, 2, 3];
    const edges = { "1-2": 300, "2-3": 300 };
    const out = largestConnectedComponent(ids, mtx(ids, edges), 1000);
    expect(out.keptIds).toEqual([1, 2, 3]);
    expect(out.droppedIds).toEqual([]);
  });

  it("breaks ties on the lowest member id", () => {
    // Two equal-size components {1,2} and {3,4}; keep the one with id 1.
    const ids = [1, 2, 3, 4];
    const edges = { "1-2": 300, "3-4": 300 };
    const out = largestConnectedComponent(ids, mtx(ids, edges), 1000);
    expect(out.keptIds).toEqual([1, 2]);
    expect(out.droppedIds).toEqual([3, 4]);
  });
});
