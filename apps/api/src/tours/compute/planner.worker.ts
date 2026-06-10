// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// piscina worker entry for the planner compute pool (ADR-0014). Runs the
// CPU-heavy pure planner computations off the API event loop. MUST import only
// pure modules — no NestJS, services, or repositories. The `PreparedContext`
// import is type-only (erased), so the I/O-importing `clustering/context.ts`
// never loads in the worker.
//
// Compiled to dist/tours/compute/planner.worker.js; the ComputePool service
// (same dir) resolves it via `new URL('./planner.worker.js', import.meta.url)`,
// which works in dev (tsc-watch) and in the Docker image (pnpm deploy).

import { Tsp } from "@gctp/shared";
import type { Tours } from "@gctp/shared";
import type { PreparedContext } from "../strategies/greedy/clustering/context.js";
import { computeClusters } from "../strategies/greedy/discover-compute.js";

/** Solve a TSP instance (planLoop's order + post-trim/fringe re-solves). */
export interface TspTask {
  kind: "tsp";
  distances: Tsp.DistanceMatrix;
  startIndex: number;
  options?: Tsp.SolveTwoOptOptions;
}

/**
 * Solve the low-overlap loop (ADR-0024) — the opt-in objective that minimises
 * `Σ dist + β · retrace`. Runs side by side with the `tsp` task; the proxy cell
 * map is built inside the worker from `coords` so only coordinates (not the
 * larger cell map) cross the boundary.
 */
export interface LowOverlapTask {
  kind: "tsp-low-overlap";
  distances: Tsp.DistanceMatrix;
  startIndex: number;
  coords: [number, number][];
  options: Tsp.SolveLowOverlapOptions;
}

/** Run the full pure cluster-discovery pipeline. */
export interface ClusterTask {
  kind: "cluster";
  ctx: PreparedContext;
  strategyName: Tours.ClusteringStrategyName;
  preferredLanduseKinds: string[];
}

export type PlannerTask = TspTask | LowOverlapTask | ClusterTask;
export type PlannerResult =
  | Tsp.TwoOptResult
  | Tsp.LowOverlapResult
  | Tours.DiscoverClustersResult;

export default function plannerTask(task: PlannerTask): PlannerResult {
  switch (task.kind) {
    case "tsp":
      return Tsp.solveTwoOpt(task.distances, task.startIndex, task.options);
    case "tsp-low-overlap":
      return Tsp.solveLowOverlapLoop(
        task.distances,
        task.startIndex,
        task.coords,
        task.options,
      );
    case "cluster":
      return computeClusters(
        task.ctx,
        task.strategyName,
        task.preferredLanduseKinds,
      );
    default: {
      const exhaustive: never = task;
      throw new Error(`unknown planner task: ${JSON.stringify(exhaustive)}`);
    }
  }
}
