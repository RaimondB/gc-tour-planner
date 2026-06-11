// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches, Geo, Tours } from "@gctp/shared";
import type { SeedSubgraph } from "../seeds.js";
import type { CoordinatedCache, WalkingEdge } from "../walking-graph.js";

/**
 * Raw clustering output — a list of cache ids and the strategy-internal
 * metadata the orchestrator uses for diagnostics / safety-net splitting.
 * Refinement (trim/dedup/MST-cut) is applied uniformly downstream.
 */
export interface RawCluster {
  cacheIds: number[];
  /** Optional provenance — Louvain uses this for the seed/resolution origin. */
  meta?: Record<string, number | string>;
}

/**
 * Inputs all strategies receive. Built once per Pass-1 invocation by
 * `prepareClusteringContext`, so swapping strategies is cheap (no extra DB
 * or OSRM calls).
 */
export interface ClusteringContext {
  /** Caches in the candidate pool, deduped + capped + already filtered. */
  pool: readonly Caches.CacheDTO[];
  /** Same caches in lng/lat-only form for the graph primitives. */
  coordinated: readonly CoordinatedCache[];
  /** Sparse, symmetric walking graph from `buildWalkingGraph`. */
  edges: readonly WalkingEdge[];
  /** H3-seeded subgraphs. Louvain consumes these; others may flatten. */
  subgraphs: readonly SeedSubgraph[];
  /** Original `PlanInput` so strategies can read user knobs themselves. */
  input: Tours.PlanInput;
  /**
   * Single equirectangular projection anchored at `input.center`, built once
   * per request. Every cache is ≤ `radiusM` (≤ 50 km) from it, so straight-line
   * distances come from `projection.distanceMeters(a, b)` — a plain Euclidean
   * `hypot`, no per-pair trig. Replaces the spherical `haversineMeters` in the
   * clustering / scoring hot paths.
   */
  projection: Geo.Projection;
}

/** Refinement stages a strategy can opt out of (default: run all). */
export type RefinementStage =
  | "walking-outlier-trim"
  | "geographic-outlier-trim"
  | "jaccard-dedup"
  | "mst-cut";

export interface ClusteringStrategy {
  readonly name: Tours.ClusteringStrategyName;

  /**
   * Produce candidate clusters from the prepared context. Refinement is the
   * orchestrator's job — strategies just emit honest partitions.
   */
  cluster(ctx: ClusteringContext): RawCluster[];

  /** Strategy knobs to echo into `ClusterDiagnostics.strategyParams`. */
  paramsForDiagnostics(ctx: ClusteringContext): Record<string, number | string>;

  /**
   * ε to report in the legacy `ClusterDiagnostics.epsilonMeters` field.
   * Returns 0 for strategies that don't have a single ε (Louvain, components).
   */
  epsilonMetersForDiagnostics(ctx: ClusteringContext): number;

  /**
   * Refinement stages to skip. Most strategies leave this undefined so the
   * full pipeline runs — HDBSCAN's noise filter overlaps with the walking
   * outlier trim, for example.
   */
  readonly skipRefinement?: ReadonlySet<RefinementStage>;
}
