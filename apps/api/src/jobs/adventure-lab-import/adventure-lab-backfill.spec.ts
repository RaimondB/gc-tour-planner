// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  adventureTitleOf,
  groupStagesForBackfill,
  type MissingIdStage,
} from "./adventure-lab-backfill.js";

describe("adventureTitleOf", () => {
  it("strips the `: S{n} …` stage suffix", () => {
    expect(adventureTitleOf("Mooie Mo(nu)menten : S1 St. Martinuskerk")).toBe(
      "Mooie Mo(nu)menten",
    );
    expect(adventureTitleOf("Title : S10 Last stop")).toBe("Title");
  });

  it("leaves a non-stage name unchanged", () => {
    expect(adventureTitleOf("Just a name")).toBe("Just a name");
  });
});

describe("groupStagesForBackfill", () => {
  let nextId = 1;
  const stage = (
    code: string,
    name: string,
    lng: number,
    lat: number,
  ): MissingIdStage => ({ id: nextId++, code, name, lng, lat });

  it("groups stages by shared title with a centre + covering radius", () => {
    const stages = [
      stage("LC1", "Adv A : S1 one", 6.0, 52.0),
      stage("LC2", "Adv A : S2 two", 6.002, 52.0),
      stage("LC3", "Adv B : S1 one", 5.0, 51.0),
    ];
    const groups = groupStagesForBackfill(stages).sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    expect(groups.map((g) => g.title)).toEqual(["Adv A", "Adv B"]);

    const a = groups[0]!;
    expect(a.members.map((m) => m.code).sort()).toEqual(["LC1", "LC2"]);
    // Centre is the centroid of A's two stages.
    expect(a.center[0]).toBeCloseTo(6.001, 5);
    expect(a.center[1]).toBeCloseTo(52.0, 5);
    // ~137 m spread from centre to each stage → radius is comfortably larger.
    expect(a.radiusM).toBeGreaterThan(600);
  });

  it("applies the minimum radius for a single-spot adventure", () => {
    const [g] = groupStagesForBackfill([
      stage("LC1", "Solo : S1 a", 6.0, 52.0),
      stage("LC2", "Solo : S2 b", 6.0, 52.0),
    ]);
    expect(g!.radiusM).toBe(800);
    expect(g!.members.map((m) => m.code).sort()).toEqual(["LC1", "LC2"]);
  });

  it("skips entries with an empty derived title", () => {
    expect(groupStagesForBackfill([stage("LC1", " : S1 x", 6, 52)])).toEqual(
      [],
    );
  });
});
