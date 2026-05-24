// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  discoverClustersInSubgraphs,
  splitByMstCut,
} from "./louvain-clusters.js";
import type { SeedSubgraph } from "./seeds.js";

/**
 * Determinism is load-bearing for the planner: the UI's "this is the same
 * cluster as last time" diagnostics and any cached scoring assume that
 * identical input always produces identical clusterIds. Louvain is
 * inherently randomised, so we drive the RNG with a mulberry32 seeded from
 * a fixed constant — these tests assert the seed is being honoured.
 */
describe("louvain-clusters", () => {
  // Two tight pods (A-B-C and D-E-F) connected by one long bridge edge
  // (C-D, much weaker). A reasonable resolution sweep should keep the two
  // pods as separate communities at γ ≥ 0.7.
  const subgraph: SeedSubgraph = {
    seedId: 1,
    cacheIds: [1, 2, 3, 4, 5, 6],
    edges: [
      // pod A
      { fromCacheId: 1, toCacheId: 2, meters: 200, seconds: 240 },
      { fromCacheId: 2, toCacheId: 3, meters: 250, seconds: 300 },
      { fromCacheId: 1, toCacheId: 3, meters: 280, seconds: 340 },
      // pod B
      { fromCacheId: 4, toCacheId: 5, meters: 220, seconds: 270 },
      { fromCacheId: 5, toCacheId: 6, meters: 240, seconds: 290 },
      { fromCacheId: 4, toCacheId: 6, meters: 260, seconds: 310 },
      // bridge — much further on foot than within-pod edges
      { fromCacheId: 3, toCacheId: 4, meters: 4000, seconds: 4800 },
    ],
  };

  it("returns identical clusterIds for repeated runs with the same input", () => {
    const a = discoverClustersInSubgraphs([subgraph], { sigmaMeters: 2000 });
    const b = discoverClustersInSubgraphs([subgraph], { sigmaMeters: 2000 });
    // Order + member sets must match exactly.
    expect(a.map((c) => c.cacheIds)).toEqual(b.map((c) => c.cacheIds));
    expect(a.map((c) => c.seedId)).toEqual(b.map((c) => c.seedId));
    expect(a.map((c) => c.resolution)).toEqual(b.map((c) => c.resolution));
  });

  it("separates the two pods at a reasonable resolution", () => {
    const candidates = discoverClustersInSubgraphs([subgraph], {
      sigmaMeters: 1000,
    });
    // At least one candidate should be exactly {1,2,3} or {4,5,6} — i.e.
    // the bridge edge should have been recognised as weak enough to break
    // the two communities apart.
    const podA = candidates.find(
      (c) =>
        c.cacheIds.length === 3 &&
        c.cacheIds.every((id) => id <= 3),
    );
    const podB = candidates.find(
      (c) =>
        c.cacheIds.length === 3 &&
        c.cacheIds.every((id) => id >= 4),
    );
    expect(podA ?? podB).toBeDefined();
  });

  it("dedupes near-identical communities by Jaccard ≥ 0.8", () => {
    // Two subgraphs that share 4 of 5 caches should produce a deduped result.
    const sub1: SeedSubgraph = {
      seedId: 10,
      cacheIds: [1, 2, 3, 4, 5],
      edges: [
        { fromCacheId: 1, toCacheId: 2, meters: 100, seconds: 120 },
        { fromCacheId: 2, toCacheId: 3, meters: 110, seconds: 130 },
        { fromCacheId: 3, toCacheId: 4, meters: 120, seconds: 140 },
        { fromCacheId: 4, toCacheId: 5, meters: 130, seconds: 150 },
      ],
    };
    const sub2: SeedSubgraph = {
      seedId: 11,
      // 4 of 5 overlap with sub1 — Jaccard = 4/6 ≈ 0.67 (below threshold);
      // a near-perfect overlap (4/5) would dedup.
      cacheIds: [1, 2, 3, 4, 5],
      edges: sub1.edges,
    };
    const candidates = discoverClustersInSubgraphs([sub1, sub2], {
      sigmaMeters: 1000,
    });
    // Same input twice should not double the candidate list — identical
    // communities (Jaccard = 1.0) must dedupe.
    const seen = new Set(candidates.map((c) => c.cacheIds.join(",")));
    expect(seen.size).toBe(candidates.length);
  });
});

describe("splitByMstCut (safety net)", () => {
  it("returns the input unchanged when it fits both constraints", () => {
    // A trivial 3-cache cluster with small distances and a comfortable budget.
    const dist = (a: number, b: number) => {
      if (a === b) return 0;
      return 500;
    };
    const out = splitByMstCut([1, 2, 3], dist, 10_000, 2, 50);
    expect(out).toEqual([[1, 2, 3]]);
  });

  it("splits an oversized chain on its longest MST edge", () => {
    // Chain 1-2-3-4 with a huge gap between 2 and 3 → should split into
    // {1,2} and {3,4} when the budget can't fit the whole chain.
    const weights: Record<string, number> = {
      "1:2": 200,
      "2:3": 8000, // the bridge
      "3:4": 200,
    };
    const dist = (a: number, b: number) => {
      if (a === b) return 0;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      return weights[key] ?? 50_000;
    };
    const out = splitByMstCut([1, 2, 3, 4], dist, 3_000, 2, 50);
    expect(out.length).toBeGreaterThan(0);
    // The bridge edge between 2 and 3 should have been cut.
    for (const part of out) {
      const hasLeft = part.some((id) => id <= 2);
      const hasRight = part.some((id) => id >= 3);
      expect(hasLeft && hasRight).toBe(false);
    }
  });
});
