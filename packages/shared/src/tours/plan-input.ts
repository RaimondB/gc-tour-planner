// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { CacheType, AttributeFilterGroups } from "../caches/index.js";
import { LngLat } from "../geo/index.js";

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
]);
export type StartPreference = z.infer<typeof StartPreference>;

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
});
export type PlanInput = z.infer<typeof PlanInput>;
