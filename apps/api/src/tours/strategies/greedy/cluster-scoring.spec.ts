// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { Geo, type Caches, type Tours } from "@gctp/shared";
import { scoreCluster, type ScoreClusterInput } from "./cluster-scoring.js";

const CENTER: readonly [number, number] = [5.12, 52.09];
const projection = Geo.makeProjection(CENTER[0], CENTER[1]);

function cache(id: number, lng: number, lat: number): Caches.CacheDTO {
  return {
    id,
    type: "Traditional",
    location: { type: "Point", coordinates: [lng, lat] },
    attributeIds: [],
    parkingPoints: [],
  } as unknown as Caches.CacheDTO;
}

const SOFT_PREFS: Tours.SoftPreferences = {
  clusterDensityWeight: 0,
  loopCompactnessWeight: 0,
  landuseWeight: 0,
};

/** Minimal input with every non-center term zeroed so we isolate centerProximity. */
function input(
  centroid: readonly [number, number],
  centerProximityWeight: number,
  radiusM = 5_000,
): ScoreClusterInput {
  return {
    caches: [
      cache(1, centroid[0], centroid[1]),
      cache(2, centroid[0], centroid[1]),
    ],
    mstLengthMeters: 1_000,
    estimatedTourMeters: 1_400,
    distanceBudgetMeters: 8_000,
    softPrefs: SOFT_PREFS,
    landuseKindsByCacheId: new Map(),
    preferredLanduseKinds: [],
    landuseWeight: 0,
    projection,
    center: CENTER,
    centroid,
    radiusM,
    centerProximityWeight,
  };
}

describe("scoreCluster — centerProximity term", () => {
  it("ranks a centroid nearer the search center higher", () => {
    // ~0.5 km east of center vs ~3 km east — both inside a 5 km radius.
    const near = scoreCluster(input([5.127, 52.09], 1));
    const far = scoreCluster(input([5.164, 52.09], 1));
    expect(near.breakdown.centerProximity).toBeGreaterThan(
      far.breakdown.centerProximity!,
    );
    expect(near.total).toBeGreaterThan(far.total);
  });

  it("peaks at 1×weight when the centroid is exactly at the center", () => {
    const atCenter = scoreCluster(input(CENTER, 3));
    expect(atCenter.breakdown.centerProximity).toBeCloseTo(3, 5);
  });

  it("omits the term entirely when the weight is 0", () => {
    const off = scoreCluster(input([5.164, 52.09], 0));
    expect(off.breakdown.centerProximity).toBeUndefined();
  });

  it("clamps to 0 (never negative) when the centroid is past the radius", () => {
    // ~3 km east with a 1 km radius → distance/radius > 1.
    const beyond = scoreCluster(input([5.164, 52.09], 2, 1_000));
    expect(beyond.breakdown.centerProximity).toBe(0);
  });
});
