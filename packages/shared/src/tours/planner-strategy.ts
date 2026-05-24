// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  ClusterCandidate,
  ClusterDiagnostics,
} from "./cluster-candidate.js";
import type { PlanInput } from "./plan-input.js";
import type { PlanLoopInput } from "./plan-loop-input.js";
import type { PlanResult } from "./plan-result.js";

/** Pass 1 return shape — candidates + diagnostics (pre-trim components, etc.). */
export interface DiscoverClustersResult {
  candidates: ClusterCandidate[];
  diagnostics: ClusterDiagnostics;
}

/**
 * Pluggable tour-planning strategy. See ADR-0002.
 *
 * Two-pass contract:
 *   discoverClusters(PlanInput)  — Pass 1: cluster discovery + scoring.
 *   planLoop(PlanLoopInput)      — Pass 2: TSP loop + parking selection.
 *
 * The pass split lets the UI show the user candidate clusters before paying
 * for the full OSRM matrix + leg geometry of any one of them.
 *
 * MVP implementation: `GreedyTspPlanner` in apps/api/src/tours/strategies/greedy/.
 * Future implementation: `SolverTourPlanner` calling a sidecar (Timefold / OR-Tools).
 *
 * Strategies must be deterministic — same input produces same output.
 */
export interface TourPlannerStrategy {
  /**
   * Pass 1 — top-N candidate clusters (ranked by score) + diagnostics
   * (pre-trim components, per-cache walkable connectivity, ε used). The
   * diagnostics block is what `gctp-planner-*.json` exports rely on for
   * "why isn't X clustering" investigations.
   */
  discoverClusters(
    ownerId: string,
    input: PlanInput,
  ): Promise<DiscoverClustersResult>;

  /** Pass 2 — turns a chosen cluster's cache-id set into a routed closed loop. */
  planLoop(ownerId: string, input: PlanLoopInput): Promise<PlanResult>;
}

/** DI token shared between NestJS modules and tests. */
export const TOUR_PLANNER = Symbol.for("@gctp/tours/TOUR_PLANNER");
export type TourPlannerToken = typeof TOUR_PLANNER;
