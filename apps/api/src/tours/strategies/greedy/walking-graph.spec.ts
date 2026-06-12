// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import type { CachesRepository } from "../../../caches/caches.repository.js";
import type { OsrmClient } from "../../../routing/osrm.client.js";
import type { RoutingRepository } from "../../../routing/routing.repository.js";
import { haversineMeters } from "./equirectangular.js";
import {
  buildWalkingGraph,
  type CoordinatedCache,
  type WalkingEdge,
} from "./walking-graph.js";

/**
 * Four caches: a tight triangle {1,2,3} plus a peripheral node 4 that hangs off
 * the cluster via node 3. With k=2, node 4 ranks {3,2} as its nearest, but
 * neither 3 nor 2 ranks 4 (their two nearest are inside the triangle). So the
 * 4→3 and 4→2 links are *one-way*.
 *
 *   - OR symmetry admits both one-way links → edges (3,4) AND (2,4).
 *   - Mutual symmetry drops both (not reciprocal); the min-degree floor then
 *     re-adds node 4's single nearest edge (3,4) so it isn't orphaned — but
 *     (2,4) stays gone.
 */
const COORDS: Record<number, readonly [number, number]> = {
  1: [0, 0],
  2: [100 / 111_320, 0],
  3: [50 / 111_320, 80 / 111_320],
  4: [60 / 111_320, 300 / 111_320],
};
const IDS = [1, 2, 3, 4];

function coordinated(): CoordinatedCache[] {
  return IDS.map((id) => ({ id, lng: COORDS[id]![0], lat: COORDS[id]![1] }));
}

/** Symmetric walking distance = haversine of the coords (ratio 1 ⇒ no detour/speed rejects). */
function dist(a: number, b: number): number {
  return haversineMeters(COORDS[a]!, COORDS[b]!);
}

function makeDeps() {
  // Over-fetch: every ordered pair is a candidate.
  const nearestNeighbors = vi.fn(async () => {
    const pairs: { fromCacheId: number; toCacheId: number }[] = [];
    for (const a of IDS)
      for (const b of IDS)
        if (a !== b) {
          pairs.push({ fromCacheId: a, toCacheId: b });
        }
    return pairs;
  });
  // Every requested pair is "cached" with its haversine distance — no OSRM hit.
  const findMatrixCells = vi.fn(
    async (pairs: { fromCacheId: number; toCacheId: number }[]) =>
      pairs.map((p) => ({
        fromCacheId: p.fromCacheId,
        toCacheId: p.toCacheId,
        meters: dist(p.fromCacheId, p.toCacheId),
        seconds: dist(p.fromCacheId, p.toCacheId) / 1.4,
        noroute: false,
      })),
  );
  const table = vi.fn(async () => {
    throw new Error("OSRM should not be called — all cells are cached");
  });
  const deps = {
    caches: { nearestNeighbors } as unknown as CachesRepository,
    routing: {
      findMatrixCells,
      upsertMatrixCells: vi.fn(async () => {}),
      upsertNorouteCells: vi.fn(async () => {}),
    } as unknown as RoutingRepository,
    osrm: { table } as unknown as OsrmClient,
  };
  return deps;
}

function baseInput(symmetry: "or" | "mutual") {
  return {
    ownerId: "owner",
    caches: coordinated(),
    kTarget: 2,
    radiusM: 5_000,
    maxEdgeMeters: 5_000,
    profile: "foot" as const,
    osrmVersion: "test",
    symmetry,
  };
}

const has = (edges: WalkingEdge[], a: number, b: number): boolean =>
  edges.some(
    (e) =>
      (e.fromCacheId === a && e.toCacheId === b) ||
      (e.fromCacheId === b && e.toCacheId === a),
  );

describe("buildWalkingGraph — k-NN symmetry", () => {
  it("OR (default) admits one-way peripheral links", async () => {
    const edges = await buildWalkingGraph(baseInput("or"), makeDeps());
    // Triangle present.
    expect(has(edges, 1, 2)).toBe(true);
    expect(has(edges, 1, 3)).toBe(true);
    expect(has(edges, 2, 3)).toBe(true);
    // Both one-way links to node 4 admitted.
    expect(has(edges, 3, 4)).toBe(true);
    expect(has(edges, 2, 4)).toBe(true);
  });

  it("mutual drops one-way links but the min-degree floor keeps node 4 connected", async () => {
    const edges = await buildWalkingGraph(baseInput("mutual"), makeDeps());
    // Triangle is reciprocal → kept.
    expect(has(edges, 1, 2)).toBe(true);
    expect(has(edges, 1, 3)).toBe(true);
    expect(has(edges, 2, 3)).toBe(true);
    // The non-reciprocal (2,4) link is gone…
    expect(has(edges, 2, 4)).toBe(false);
    // …but node 4 is not orphaned: the floor re-added its single nearest edge.
    expect(has(edges, 3, 4)).toBe(true);
    expect(edges.some((e) => e.fromCacheId === 4 || e.toCacheId === 4)).toBe(
      true,
    );
  });

  it("mutual with min-degree floor 2 tops node 4 back up to its two nearest", async () => {
    const edges = await buildWalkingGraph(
      { ...baseInput("mutual"), mutualFloor: 2 },
      makeDeps(),
    );
    // Floor 2 restores node 4's second-nearest edge that floor 1 left out.
    expect(has(edges, 3, 4)).toBe(true);
    expect(has(edges, 2, 4)).toBe(true);
    const node4Degree = edges.filter(
      (e) => e.fromCacheId === 4 || e.toCacheId === 4,
    ).length;
    expect(node4Degree).toBe(2);
  });

  it("mutual yields a strict subset of OR's edges (plus floor edges)", async () => {
    const orEdges = await buildWalkingGraph(baseInput("or"), makeDeps());
    const mutualEdges = await buildWalkingGraph(
      baseInput("mutual"),
      makeDeps(),
    );
    expect(mutualEdges.length).toBeLessThan(orEdges.length);
  });
});
