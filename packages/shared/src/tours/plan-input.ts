// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { CacheType, AttributeFilterGroups } from "../caches/index.js";
import { LngLat } from "../geo/index.js";
import {
  ParkingAccessChip,
  ParkingFeeFilter,
} from "../parking-facilities/index.js";

export const TargetedWeight = z.object({
  value: z.number(),
  tolerance: z.number().positive(),
  weight: z.number(),
});
export type TargetedWeight = z.infer<typeof TargetedWeight>;

export const SoftPreferences = z.object({
  landuseProfileId: z.string().uuid().optional(),
  attributePreferences: z.record(z.string(), z.number()).optional(),
  difficultyTarget: TargetedWeight.optional(),
  terrainTarget: TargetedWeight.optional(),
  clusterDensityWeight: z.number().default(1),
  loopCompactnessWeight: z.number().default(1),
  /**
   * Multiplier on `landuseMatch` (0..1, fraction of cluster caches
   * inside a preferred-kind polygon). Default 1 — same contribution as
   * `parkingPresence`. Bump to 3-5 when a profile match should dominate
   * the ranking; sidebar slider 0..5.
   */
  landuseWeight: z.number().min(0).max(5).default(1),
});
export type SoftPreferences = z.infer<typeof SoftPreferences>;

export const HardFilters = z.object({
  types: z.array(CacheType).optional(),
  attributes: AttributeFilterGroups.optional(),
});
export type HardFilters = z.infer<typeof HardFilters>;

export const StartPreference = z.enum([
  "parking-waypoint",
  "osrm-nearest-road",
  "user-supplied-point",
  // OSM-sourced amenity=parking facilities (ADR-0011). Filtered by
  // `osmParkingAccessFilter` + `osmParkingFeeFilter`; the planner walks
  // each candidate to the cluster's nearest cache via OSRM and picks the
  // shortest.
  "osm-parking",
]);
export type StartPreference = z.infer<typeof StartPreference>;

/**
 * Pass-1 cluster-finding algorithm. Selectable per request so the UI can
 * A/B compare the same `PlanInput` across strategies; defaults from the
 * `PLANNER_CLUSTERING` env var (and falls back to `louvain`).
 *
 *  - `louvain`     — community detection on a sparse walking graph (default).
 *  - `dbscan`      — density-based clustering using `maxLinkMeters` as ε.
 *  - `hdbscan`     — density-reachable, mutual-NN; produces stability scores.
 *  - `components`  — connected components on the capped walking graph (baseline).
 */
export const ClusteringStrategyName = z.enum([
  "louvain",
  "dbscan",
  "hdbscan",
  "components",
]);
export type ClusteringStrategyName = z.infer<typeof ClusteringStrategyName>;

export const PlanInput = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
  maxCaches: z.number().int().min(2).max(50).default(15),
  /**
   * Lower bound on cluster size. After single-linkage clustering on the
   * ε-graph, any component smaller than this is dropped. The trim step
   * also stops shrinking when it would push a cluster below this size.
   */
  minClusterSize: z.number().int().min(2).max(50).default(8),
  /**
   * Maximum walking distance (meters) between two caches for them to link
   * into the same cluster — direct knob on DBSCAN's ε. Decoupled from
   * `distanceBudgetMeters` / `minClusterSize` so the user can experiment
   * with link distance without fighting the budget math. Walking distance
   * (not straight-line) — comes from the OSRM matrix the planner already
   * computes for cluster discovery.
   */
  maxLinkMeters: z.number().int().min(200).max(5000).default(1500),
  distanceBudgetMeters: z.number().int().positive().max(25_000).default(8_000),
  timeBudgetMinutes: z.number().int().positive().max(720).optional(),
  hardFilters: HardFilters,
  softPreferences: SoftPreferences,
  startPreference: StartPreference.default("parking-waypoint"),
  userSuppliedStart: LngLat.optional(),
  /**
   * How many ranked clusters to return from Pass 1. The planner always
   * sorts by score; this just sets the cut-off. Capped at 20 — anything
   * higher is more useful for diagnostics than planning.
   */
  topNClusters: z.number().int().min(1).max(20).default(5),
  /**
   * Applies only when `startPreference === "osm-parking"`. Defaults to
   * `["yes", "customers"]` — `permit` is opt-in (ADR-0011): a permit you
   * don't have is functionally the same as private.
   */
  osmParkingAccessFilter: z
    .array(ParkingAccessChip)
    .default(["yes", "customers"]),
  /**
   * Applies only when `startPreference === "osm-parking"`. `any` (default)
   * lets the planner pick the closest candidate regardless of fee.
   */
  osmParkingFeeFilter: ParkingFeeFilter.default("any"),
  /**
   * Which Pass-1 clustering algorithm to use. When omitted, the server falls
   * back to the `PLANNER_CLUSTERING` env default (and ultimately `louvain`).
   * The chosen strategy is echoed back in `ClusterDiagnostics.strategyUsed`.
   */
  clusteringStrategy: ClusteringStrategyName.optional(),
});
export type PlanInput = z.infer<typeof PlanInput>;
