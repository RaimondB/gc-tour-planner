// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { Routing } from "@gctp/shared";
import {
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
