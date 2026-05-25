// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches, Tours } from "@gctp/shared";
import { describe, expect, it } from "vitest";
import type { SeedSubgraph } from "../seeds.js";
import type { CoordinatedCache, WalkingEdge } from "../walking-graph.js";
import { componentsStrategy } from "./components.js";
import { dbscanStrategy } from "./dbscan.js";
import { hdbscanStrategy } from "./hdbscan.js";
import { louvainStrategy } from "./louvain.js";
import {
  CLUSTERING_STRATEGIES,
  resolveClusteringStrategy,
} from "./index.js";
import { refineClusters } from "./refine.js";
import type { ClusteringContext } from "./strategy.js";

/**
 * Two tight pods (1-2-3 around (0,0) and 4-5-6 around (0.02, 0.02), ~2 km
 * apart) plus a lone outlier (7). We expect EVERY strategy to keep the two
 * pods separate at maxLinkMeters=600. The outlier should never make it into
 * a cluster (no edges connect it).
 */
function buildFixture(): ClusteringContext {
  const caches: Caches.CacheDTO[] = [
    cache(1, 0.0000, 0.0000),
    cache(2, 0.0010, 0.0000),
    cache(3, 0.0000, 0.0010),
    cache(4, 0.0200, 0.0200),
    cache(5, 0.0210, 0.0200),
    cache(6, 0.0200, 0.0210),
    cache(7, 0.1000, 0.1000),
  ];
  const coordinated: CoordinatedCache[] = caches.map((c) => ({
    id: c.id,
    lng: c.location.coordinates[0]!,
    lat: c.location.coordinates[1]!,
  }));
  const edges: WalkingEdge[] = [
    // Pod A — three tight edges (~111 m each).
    edge(1, 2, 111),
    edge(2, 3, 156),
    edge(1, 3, 111),
    // Pod B — three tight edges (~111 m each).
    edge(4, 5, 111),
    edge(5, 6, 156),
    edge(4, 6, 111),
    // (no bridge edge — pods are >2 km apart, beyond the cap of 600 m.)
    // Cache 7 is isolated.
  ];
  const subgraphs: SeedSubgraph[] = [
    { seedId: 1, cacheIds: [1, 2, 3, 4, 5, 6, 7], edges },
  ];
  return {
    pool: caches,
    coordinated,
    edges,
    subgraphs,
    input: planInput({ maxLinkMeters: 600, minClusterSize: 2, maxCaches: 10 }),
  };
}

describe("clustering strategies — all four agree on the obvious fixture", () => {
  const ctx = buildFixture();

  for (const [name, strategy] of Object.entries(CLUSTERING_STRATEGIES)) {
    it(`${name} produces two distinct pods and excludes the outlier`, () => {
      const raw = strategy.cluster(ctx);
      const refined = refineClusters(raw, ctx, strategy.skipRefinement);

      // At least two clusters survive — one per pod.
      expect(refined.length).toBeGreaterThanOrEqual(2);

      const allMembers = new Set<number>();
      for (const c of refined) for (const id of c) allMembers.add(id);
      // Cache 7 has no walking-graph edge → either dropped by the strategy or
      // by the walking-outlier trim.
      expect(allMembers.has(7)).toBe(false);

      // Each pod's three caches should land together in *some* cluster.
      const podAFound = refined.some(
        (c) => c.includes(1) && c.includes(2) && c.includes(3),
      );
      const podBFound = refined.some(
        (c) => c.includes(4) && c.includes(5) && c.includes(6),
      );
      expect(podAFound).toBe(true);
      expect(podBFound).toBe(true);
    });

    it(`${name} is deterministic — same input ⇒ identical output`, () => {
      const a = strategy.cluster(ctx);
      const b = strategy.cluster(ctx);
      expect(b.map((r) => r.cacheIds)).toEqual(a.map((r) => r.cacheIds));
    });

    it(`${name} echoes strategy params for diagnostics`, () => {
      const params = strategy.paramsForDiagnostics(ctx);
      expect(Object.keys(params).length).toBeGreaterThan(0);
    });
  }
});

describe("resolveClusteringStrategy", () => {
  it("honours the request-supplied strategy", () => {
    expect(resolveClusteringStrategy("dbscan", "louvain").name).toBe("dbscan");
  });
  it("falls back to env default when request is undefined", () => {
    expect(resolveClusteringStrategy(undefined, "hdbscan").name).toBe("hdbscan");
  });
  it("falls back to louvain on unknown env value", () => {
    expect(resolveClusteringStrategy(undefined, "garbage").name).toBe("louvain");
  });
  it("falls back to louvain when both are undefined", () => {
    expect(resolveClusteringStrategy(undefined, undefined).name).toBe("louvain");
  });
});

describe("refineClusters — shared post-processing", () => {
  it("drops below-minClusterSize survivors", () => {
    const ctx = buildFixture();
    const tight = {
      ...ctx,
      input: { ...ctx.input, minClusterSize: 4 },
    };
    // Components strategy would output two 3-member pods; both should be
    // dropped by refinement at minClusterSize=4.
    const raw = componentsStrategy.cluster(tight);
    const refined = refineClusters(raw, tight);
    expect(refined.length).toBe(0);
  });

  it("dedupes near-identical clusters across resolutions", () => {
    const ctx = buildFixture();
    const dup = louvainStrategy.cluster(ctx);
    // Louvain's resolution sweep often returns the same pod at multiple γs.
    const refined = refineClusters(dup, ctx);
    const seen = new Set(refined.map((c) => c.join(",")));
    expect(seen.size).toBe(refined.length);
  });

  it("honours skipRefinement set passed by the strategy", () => {
    const ctx = buildFixture();
    const raw = hdbscanStrategy.cluster(ctx);
    // HDBSCAN opts out of walking-outlier-trim — its own noise filter handles it.
    // Refinement should still complete without throwing or losing the pods.
    const refined = refineClusters(raw, ctx, hdbscanStrategy.skipRefinement);
    expect(refined.length).toBeGreaterThanOrEqual(1);
  });
});

describe("dbscan vs louvain — bridge edge handling", () => {
  // DBSCAN with ε = 5000 m will eagerly chain through a long bridge edge;
  // Louvain at the same σ should still keep the pods apart via modularity.
  // (Sanity check that strategies aren't producing identical output — if they
  // were, the comparison harness would be useless.)
  it("DBSCAN at a permissive ε can fuse pods that Louvain keeps separate", () => {
    const fixture = buildFixture();
    const fused: ClusteringContext = {
      ...fixture,
      // Add a bridge edge connecting the two pods through node 3↔4.
      edges: [
        ...fixture.edges,
        edge(3, 4, 4_000),
      ],
      input: { ...fixture.input, maxLinkMeters: 5_000 },
    };

    const dbscanResult = dbscanStrategy.cluster(fused);
    const louvainResult = louvainStrategy.cluster(fused);

    // DBSCAN at ε=5000 with this bridge collapses both pods into a single
    // chain. Louvain weights the bridge as exp(-4000/1667)≈0.09, far below
    // intra-pod weights, and keeps them apart.
    const dbscanFused = dbscanResult.some(
      (c) =>
        c.cacheIds.includes(1) &&
        c.cacheIds.includes(4),
    );
    expect(dbscanFused).toBe(true);

    const louvainKeptApart = louvainResult.some(
      (c) =>
        c.cacheIds.length === 3 &&
        c.cacheIds.every((id) => id <= 3),
    );
    expect(louvainKeptApart).toBe(true);
  });
});

/* --- fixture helpers ---------------------------------------------------- */

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

function planInput(over: Partial<Tours.PlanInput> = {}): Tours.PlanInput {
  return {
    center: [0, 0],
    radiusM: 10_000,
    maxCaches: 50,
    minClusterSize: 3,
    maxLinkMeters: 1_500,
    distanceBudgetMeters: 8_000,
    hardFilters: {},
    softPreferences: { clusterDensityWeight: 1, loopCompactnessWeight: 1 },
    startPreference: "parking-waypoint",
    ...over,
  };
}
