// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Geo, type Caches, type Tours } from "@gctp/shared";
import { describe, expect, it } from "vitest";
import type { PreparedContext } from "../strategies/greedy/clustering/context.js";
import type { SeedSubgraph } from "../strategies/greedy/seeds.js";
import type {
  CoordinatedCache,
  WalkingEdge,
} from "../strategies/greedy/walking-graph.js";
import plannerTask from "./planner.worker.js";

// Two tight pods (~111 m intra-edges) ~2 km apart, anchored at (0, 0). Mirrors
// the clustering.spec fixture: every strategy keeps the pods separate.
function buildPreparedContext(): PreparedContext {
  const pool: Caches.CacheDTO[] = [
    cache(1, 0.0, 0.0),
    cache(2, 0.001, 0.0),
    cache(3, 0.0, 0.001),
    cache(4, 0.02, 0.02),
    cache(5, 0.021, 0.02),
    cache(6, 0.02, 0.021),
  ];
  const coordinated: CoordinatedCache[] = pool.map((c) => ({
    id: c.id,
    lng: c.location.coordinates[0]!,
    lat: c.location.coordinates[1]!,
  }));
  const edges: WalkingEdge[] = [
    edge(1, 2, 111),
    edge(2, 3, 156),
    edge(1, 3, 111),
    edge(4, 5, 111),
    edge(5, 6, 156),
    edge(4, 6, 111),
  ];
  const subgraphs: SeedSubgraph[] = [
    { seedId: 1, cacheIds: [1, 2, 3, 4, 5, 6], edges },
  ];
  return {
    pool,
    coordinated,
    edges,
    subgraphs,
    input: planInput(),
    projection: Geo.makeProjection(0, 0),
    landuseKindsByCacheId: new Map<number, readonly string[]>(),
    adventureExpansion: new Map<number, number[]>(),
  };
}

describe("planner worker — cluster-task serialization (ADR-0014)", () => {
  // Regression: #47 added `projection` (a methods-bearing object) to
  // PreparedContext, which the worker pool tries to structure-clone — Piscina
  // threw `DataCloneError: project(lng, lat)` on every real cluster discovery.
  // Benches/units never caught it because they call computeClusters inline.
  it("the live projection cannot cross the structured-clone boundary", () => {
    const ctx = buildPreparedContext();
    expect(() => structuredClone(ctx)).toThrow();
  });

  it("a projection-stripped context IS structure-cloneable", () => {
    const { projection: _projection, ...serializable } = buildPreparedContext();
    expect(() => structuredClone(serializable)).not.toThrow();
  });

  it("the worker rehydrates the projection and runs discovery on a stripped, cloned ctx", () => {
    // Reproduce exactly what the pool does: strip the projection on the sender,
    // structure-clone across the boundary, hand the bare ctx to the worker.
    const { projection: _projection, ...serializable } = buildPreparedContext();
    const wire = structuredClone(serializable);
    const result = plannerTask({
      kind: "cluster",
      ctx: wire,
      strategyName: "hdbscan-star",
      preferredLanduseKinds: [],
    }) as Tours.DiscoverClustersResult;
    // Two pods → at least one scored candidate. A missing/un-rehydrated
    // projection would throw inside computeClusters before reaching here.
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("expands adventure representatives back to all stages in candidate cacheIds (FR-I17)", () => {
    // Node 4 is the representative of an adventure whose other stages (7, 8)
    // were collapsed away before clustering. The pod {4,5,6} must surface with
    // those stages spliced back in.
    const base = buildPreparedContext();
    const ctx: PreparedContext = {
      ...base,
      adventureExpansion: new Map<number, number[]>([[4, [4, 7, 8]]]),
    };
    const { projection: _projection, ...serializable } = ctx;
    const result = plannerTask({
      kind: "cluster",
      ctx: structuredClone(serializable),
      strategyName: "hdbscan-star",
      preferredLanduseKinds: [],
    }) as Tours.DiscoverClustersResult;

    const pod = result.candidates.find((c) => c.cacheIds.includes(5));
    expect(pod).toBeDefined();
    // Representative 4 expanded to its stages; 5 and 6 (plain pod members) stay.
    expect(pod!.cacheIds).toEqual(expect.arrayContaining([4, 5, 6, 7, 8]));
  });
});

function cache(id: number, lng: number, lat: number): Caches.CacheDTO {
  return {
    id,
    source: "gpx",
    sourceId: `GC${id}`,
    code: `GC${id}`,
    type: "Traditional",
    name: `cache ${id}`,
    location: { type: "Point", coordinates: [lng, lat] },
    difficulty: null,
    terrain: null,
    size: null,
    archived: false,
    attributeIds: [],
    parkingPoints: [],
    foundByMe: false,
  };
}

function edge(a: number, b: number, meters: number): WalkingEdge {
  const [from, to] = a < b ? [a, b] : [b, a];
  return { fromCacheId: from, toCacheId: to, meters, seconds: meters * 0.72 };
}

function planInput(): Tours.PlanInput {
  return {
    center: [0, 0],
    radiusM: 10_000,
    minClusterSize: 2,
    maxLinkMeters: 600,
    distanceBudgetMeters: 8_000,
    hardFilters: {},
    softPreferences: {
      clusterDensityWeight: 1,
      loopCompactnessWeight: 1,
      landuseWeight: 1,
    },
    startPreference: "parking-waypoint",
  };
}
