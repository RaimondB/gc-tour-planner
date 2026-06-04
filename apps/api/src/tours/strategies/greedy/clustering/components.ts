// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { WalkingEdge } from "../walking-graph.js";
import type {
  ClusteringContext,
  ClusteringStrategy,
  RawCluster,
} from "./strategy.js";

/**
 * Baseline: drop edges already filtered to ≤ `maxLinkMeters` by
 * `buildWalkingGraph`, take connected components, return them as raw
 * clusters. The shared `mst-cut` refinement stage splits anything that
 * exceeds the distance budget.
 *
 * If Louvain or HDBSCAN don't materially beat this on real data, the
 * bottleneck is in graph construction / edge weights, not the algorithm.
 */
export const componentsStrategy: ClusteringStrategy = {
  name: "components",

  cluster(ctx: ClusteringContext): RawCluster[] {
    const idSet = new Set(ctx.pool.map((c) => c.id));
    return connectedComponents(idSet, ctx.edges)
      .filter((ids) => ids.length >= 2)
      .map((ids) => ({ cacheIds: ids.sort((a, b) => a - b) }));
  },

  paramsForDiagnostics(ctx) {
    return {
      maxLinkMeters: ctx.input.maxLinkMeters,
    };
  },

  epsilonMetersForDiagnostics() {
    return 0;
  },
};

function connectedComponents(
  nodes: ReadonlySet<number>,
  edges: readonly WalkingEdge[],
): number[][] {
  const adj = new Map<number, Set<number>>();
  for (const id of nodes) adj.set(id, new Set());
  for (const e of edges) {
    if (!nodes.has(e.fromCacheId) || !nodes.has(e.toCacheId)) continue;
    adj.get(e.fromCacheId)!.add(e.toCacheId);
    adj.get(e.toCacheId)!.add(e.fromCacheId);
  }

  const visited = new Set<number>();
  const components: number[][] = [];
  // Iterate in sorted order for determinism.
  const ordered = Array.from(nodes).sort((a, b) => a - b);
  for (const start of ordered) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const u = queue.shift()!;
      component.push(u);
      for (const v of adj.get(u) ?? []) {
        if (!visited.has(v)) {
          visited.add(v);
          queue.push(v);
        }
      }
    }
    components.push(component);
  }
  return components;
}
