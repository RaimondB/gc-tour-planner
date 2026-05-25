// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { discoverClustersInSubgraphs } from "../louvain-clusters.js";
import type { ClusteringContext, ClusteringStrategy, RawCluster } from "./strategy.js";

/**
 * Default strategy. σ in `w(i,j) = exp(-d_ij / σ)` is `maxLinkMeters / 3` —
 * see [greedy-tsp-planner.ts:152-158] for the rationale.
 */
export const louvainStrategy: ClusteringStrategy = {
  name: "louvain",

  cluster(ctx: ClusteringContext): RawCluster[] {
    const sigmaMeters = ctx.input.maxLinkMeters / 3;
    const candidates = discoverClustersInSubgraphs(ctx.subgraphs, {
      sigmaMeters,
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
