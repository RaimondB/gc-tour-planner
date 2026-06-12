// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export * from "./strategy.js";
export { refineClusters, projectTrims, projectMstSplit } from "./refine.js";
export { prepareClusteringContext } from "./context.js";
export type { ContextStats, PreparedContext } from "./context.js";
// The strategy registry lives in a pure module (no I/O) so the worker-thread
// planner pipeline can import it without pulling in context.ts (ADR-0014).
export {
  CLUSTERING_STRATEGIES,
  resolveClusteringStrategy,
} from "./registry.js";
