// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  summarizeAdventureCompletion,
  type AdventureStageLike,
} from "./adventure-completion.js";

function stage(
  adventureId: string | null,
  stageTotal: number | null,
  name: string,
): AdventureStageLike {
  return { adventureId, stageTotal, name };
}

describe("summarizeAdventureCompletion", () => {
  it("groups stages by adventure, counts included + dropped, derives the title", () => {
    const cacheById = new Map<number, AdventureStageLike>([
      [1, stage("adv-a", 3, "Adventure A : S1 First")],
      [2, stage("adv-a", 3, "Adventure A : S2 Second")],
      [3, stage("adv-a", 3, "Adventure A : S3 Third")], // dropped
      [4, stage(null, null, "GC123 Regular cache")], // non-AL, ignored
      [5, stage("adv-b", 2, "Adventure B : S1 Alpha")],
      [6, stage("adv-b", 2, "Adventure B : S2 Beta")],
    ]);

    const result = summarizeAdventureCompletion(
      [1, 2, 4, 5, 6],
      [3],
      cacheById,
    );

    // adv-a is incomplete (2/3, 1 dropped) → sorts before the complete adv-b.
    expect(result).toEqual([
      {
        adventureId: "adv-a",
        name: "Adventure A",
        included: 2,
        dropped: 1,
        total: 3,
      },
      {
        adventureId: "adv-b",
        name: "Adventure B",
        included: 2,
        dropped: 0,
        total: 2,
      },
    ]);
  });

  it("ignores non-AL caches and returns empty when none are labs", () => {
    const cacheById = new Map<number, AdventureStageLike>([
      [1, stage(null, null, "GC1")],
      [2, stage(null, null, "GC2")],
    ]);
    expect(summarizeAdventureCompletion([1, 2], [], cacheById)).toEqual([]);
  });

  it("tolerates unknown total (null) — included still counts", () => {
    const cacheById = new Map<number, AdventureStageLike>([
      [1, stage("adv-x", null, "Adventure X : S1 One")],
    ]);
    const [entry] = summarizeAdventureCompletion([1], [], cacheById);
    expect(entry).toMatchObject({
      included: 1,
      total: null,
      name: "Adventure X",
    });
  });
});
