// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import {
  CacheType,
  AttributeFilterGroups,
  MultiSubtypeFilter,
} from "../caches/index.js";
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
  landuseProfileId: z.guid().optional(),
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
  /**
   * The map's filter set, forwarded so the discovery pool == the set shown on
   * the map ("whatever is visible after filtering is what gets clustered").
   * All optional; omitted = no narrowing. `excludeFound` stays implicit `true`
   * in the pool regardless — you never plan a tour to caches you've found.
   */
  solvedMysteriesOnly: z.boolean().optional(),
  multiSubtype: MultiSubtypeFilter.optional(),
  hideToolCaches: z.boolean().optional(),
  /** Landuse hard-filter kinds (same as CachesQuery.contexts). */
  contexts: z.array(z.string()).optional(),
});
export type HardFilters = z.infer<typeof HardFilters>;

export const StartPreference = z.enum([
  // Try every source in turn — cache-owner parking → OSM amenity=parking →
  // nearest car-accessible road — and use the first that yields a feasible
  // start (one reachable within `maxLinkMeters`). The default; zero-config.
  "auto",
  "parking-waypoint",
  "osrm-nearest-road",
  // The user clicks the map to set an explicit start point (carried in
  // `userSuppliedStart`).
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
 * `PLANNER_CLUSTERING` env var (and falls back to `hdbscan-star`).
 *
 *  - `louvain`      — community detection on a sparse walking graph.
 *  - `leiden`       — Louvain + refinement; guarantees connected communities.
 *  - `dbscan`       — density-based clustering using `maxLinkMeters` as ε.
 *  - `hdbscan`      — robust-single-linkage core + recursive MST bisection
 *                     (NOT full HDBSCAN; kept for A/B against `hdbscan-star`).
 *  - `hdbscan-star` — true HDBSCAN* (Excess-of-Mass stability extraction over
 *                     the mutual-reachability MST). **Default** — best
 *                     end-to-end (most caches per routed loop, least fringe).
 *  - `components`   — connected components on the capped walking graph (baseline).
 */
export const ClusteringStrategyName = z.enum([
  "louvain",
  "leiden",
  "dbscan",
  "hdbscan",
  "hdbscan-star",
  "components",
]);
export type ClusteringStrategyName = z.infer<typeof ClusteringStrategyName>;

export const PlanInput = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
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
  startPreference: StartPreference.default("auto"),
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
  /**
   * Opt-in: before clustering, enrich the planning area with nearby Adventure
   * Lab stages (fetched from Lab2Gpx, upserted as ordinary caches). Default
   * `false` — not every user wants labs in their tours. Enrichment also requires
   * the server-side admin flag `ADVENTURE_LAB_ENRICHMENT_ENABLED`; when that's
   * off this request flag is a silent no-op. Once imported the stages persist
   * and participate in planning like any other cache (included when they fit the
   * budget).
   */
  includeAdventureLabs: z.boolean().default(false),
});
export type PlanInput = z.infer<typeof PlanInput>;
