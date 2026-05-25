// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Tours } from "@gctp/shared";
import { componentsStrategy } from "./components.js";
import { dbscanStrategy } from "./dbscan.js";
import { hdbscanStrategy } from "./hdbscan.js";
import { louvainStrategy } from "./louvain.js";
import type { ClusteringStrategy } from "./strategy.js";

export * from "./strategy.js";
export { refineClusters, projectTrims, projectMstSplit } from "./refine.js";
export { prepareClusteringContext } from "./context.js";
export type { PreparedContext } from "./context.js";

/** All registered clustering strategies, keyed by name. */
export const CLUSTERING_STRATEGIES: Readonly<
  Record<Tours.ClusteringStrategyName, ClusteringStrategy>
> = {
  louvain: louvainStrategy,
  dbscan: dbscanStrategy,
  hdbscan: hdbscanStrategy,
  components: componentsStrategy,
};

/**
 * Pick the strategy for a request. Request-supplied wins; falls back to the
 * env default (`PLANNER_CLUSTERING`), then `louvain`. Unknown values warn and
 * fall back rather than throwing — keeps the planner forgiving when a
 * mistyped env var lands in production.
 */
export function resolveClusteringStrategy(
  requestStrategy: Tours.ClusteringStrategyName | undefined,
  envDefault: string | undefined,
): ClusteringStrategy {
  const name = requestStrategy ?? coerceName(envDefault) ?? "louvain";
  return CLUSTERING_STRATEGIES[name];
}

function coerceName(value: string | undefined): Tours.ClusteringStrategyName | undefined {
  if (!value) return undefined;
  if (value in CLUSTERING_STRATEGIES) {
    return value as Tours.ClusteringStrategyName;
  }
  return undefined;
}
