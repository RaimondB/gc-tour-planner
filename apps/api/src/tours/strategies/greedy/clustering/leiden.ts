// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { discoverClustersInSubgraphs } from "../louvain-clusters.js";
import type {
  ClusteringContext,
  ClusteringStrategy,
  RawCluster,
} from "./strategy.js";

/**
 * Leiden community detection — same weighted graph, resolution sweep, σ, seed
 * and Jaccard dedup as `louvain`, but with Leiden's refinement phase, which
 * guarantees every returned community is internally connected (Louvain's known
 * defect). Hand-rolled detector in `leiden-detect.ts` (no third-party dep).
 * A/B against `louvain` via the explain endpoint.
 */
export const leidenStrategy: ClusteringStrategy = {
  name: "leiden",

  cluster(ctx: ClusteringContext): RawCluster[] {
    const sigmaMeters = ctx.input.maxLinkMeters / 3;
    const candidates = discoverClustersInSubgraphs(ctx.subgraphs, {
      sigmaMeters,
      algorithm: "leiden",
    });
    return candidates.map((c) => ({
      cacheIds: c.cacheIds.slice(),
      meta: {
        seedId: c.seedId,
        resolution: c.resolution,
        internalWeight: c.internalWeight,
      },
    }));
  },

  paramsForDiagnostics(ctx) {
    return {
      sigmaMeters: ctx.input.maxLinkMeters / 3,
      kTarget: Number.parseInt(process.env.PLANNER_KNN_K ?? "12", 10),
      seed: Number.parseInt(process.env.LOUVAIN_SEED ?? "42", 10),
    };
  },

  epsilonMetersForDiagnostics() {
    return 0;
  },
};
