// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  buildMreachEdges,
  computeCoreDistances,
  effectiveMinSamples,
} from "./hdbscan.js";
import {
  extractHdbscanClusters,
  type HdbscanSelection,
} from "./hdbscan-tree.js";
import type {
  ClusteringContext,
  ClusteringStrategy,
  RawCluster,
} from "./strategy.js";

/**
 * True HDBSCAN* — the density-aware strategy the legacy `hdbscan` only
 * approximated. It reuses the same core-distance + mutual-reachability
 * primitives, then applies canonical condensed-tree **stability extraction**
 * (Excess of Mass) instead of the legacy recursive largest-edge bisection.
 *
 * Why this matters: bisection always cuts the longest internal edge, so a real
 * but loosely-spaced pod gets over-split. EoM keeps a cluster whole when it is
 * more *stable* (persists across a wider λ band) than its sub-splits — the
 * defining behaviour of HDBSCAN. Shipped alongside `hdbscan` so the explain
 * endpoint can A/B the two on identical data.
 *
 * Selection mode is `eom` by default; `PLANNER_HDBSCAN_SELECTION=leaf` switches
 * to leaf selection (finer, more clusters). Read once at module load — keeps
 * the strategy pure for the worker-thread pipeline (ADR-0014).
 */
const SELECTION: HdbscanSelection =
  process.env.PLANNER_HDBSCAN_SELECTION === "leaf" ? "leaf" : "eom";

export const hdbscanStarStrategy: ClusteringStrategy = {
  name: "hdbscan-star",

  cluster(ctx: ClusteringContext): RawCluster[] {
    if (ctx.pool.length < 2) return [];
    const minSamples = effectiveMinSamples(ctx.input.minClusterSize);
    const ids = ctx.pool.map((c) => c.id);
    const coreDist = computeCoreDistances(ids, ctx.edges, minSamples);
    const mreachEdges = buildMreachEdges(ctx.edges, coreDist);

    return extractHdbscanClusters(ids, mreachEdges, ctx.input.minClusterSize, {
      selection: SELECTION,
    }).map((cacheIds) => ({ cacheIds }));
  },

  paramsForDiagnostics(ctx) {
    return {
      minClusterSize: ctx.input.minClusterSize,
      minSamples: effectiveMinSamples(ctx.input.minClusterSize),
      maxLinkMeters: ctx.input.maxLinkMeters,
      selection: SELECTION,
    };
  },

  epsilonMetersForDiagnostics() {
    return 0;
  },

  // Same rationale as the legacy `hdbscan` strategy: HDBSCAN*'s noise handling
  // already excludes sparse-neighbourhood caches (fall-out points + +Inf
  // core-distance caches never reach a selected cluster), so the walking
  // outlier trim would be a no-op. The geographic trim and mst-cut still run —
  // mst-cut is the only stage that enforces the distance budget, which density
  // stability knows nothing about.
  skipRefinement: new Set(["walking-outlier-trim"] as const),
};
