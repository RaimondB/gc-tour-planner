// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, LngLat } from "../geo/index.js";
import { HardFilters } from "./plan-input.js";

/**
 * Request the sparse walking graph the planner would build for a search area.
 * Cheap to call — reuses `prepareClusteringContext` — and the response is
 * UI-renderable as MapLibre line/circle layers for debugging.
 */
export const WalkingGraphInput = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
  hardFilters: HardFilters,
  maxLinkMeters: z.number().int().min(200).max(5_000).default(1_500),
  distanceBudgetMeters: z.number().int().positive().max(25_000).default(8_000),
});
export type WalkingGraphInput = z.infer<typeof WalkingGraphInput>;

const WalkingGraphNode = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  lng: z.number(),
  lat: z.number(),
  /** Edge count touching this node — 0 means the cache is isolated. */
  degree: z.number().int().nonnegative(),
});
export type WalkingGraphNode = z.infer<typeof WalkingGraphNode>;

const WalkingGraphEdge = z.object({
  a: z.number().int().positive(),
  b: z.number().int().positive(),
  /** OSRM walking distance in metres. May be 0 for suspicious cells — see `suspicious`. */
  walkingM: z.number().nonnegative(),
  walkingS: z.number().nonnegative(),
  /** Straight-line distance in metres — sanity reference. */
  haversineM: z.number().nonnegative(),
  /**
   * True when `walkingM` looks bogus: zero (or near-zero) despite a
   * non-trivial haversine. These cells are usually stale `route_legs` rows
   * left over from an earlier bad OSRM response — the planner still uses
   * them today, which is why visually-near caches sometimes refuse to cluster.
   */
  suspicious: z.boolean(),
});
export type WalkingGraphEdge = z.infer<typeof WalkingGraphEdge>;

/** Same context as `WalkingGraphInput`. Returns counts of what was purged. */
export const PurgeBogusInput = WalkingGraphInput;
export type PurgeBogusInput = z.infer<typeof PurgeBogusInput>;

export const PurgeBogusResponse = z.object({
  poolSize: z.number().int().nonnegative(),
  /** Stored walking distances ≤ this (m) were considered suspicious. */
  walkingMaxMeters: z.number().nonnegative(),
  /** Cache pairs separated by ≥ this haversine (m) were considered suspicious. */
  haversineMinMeters: z.number().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
});
export type PurgeBogusResponse = z.infer<typeof PurgeBogusResponse>;

/**
 * Ask the live OSRM container for the foot route between two of the user's
 * caches. Bypasses the route_legs cache entirely — the point is to see what
 * OSRM *currently* says, not what's been stored.
 */
export const TestRouteInput = z.object({
  fromCacheId: z.number().int().positive(),
  toCacheId: z.number().int().positive(),
});
export type TestRouteInput = z.infer<typeof TestRouteInput>;

export const TestRouteResponse = z.object({
  fromCacheId: z.number().int().positive(),
  toCacheId: z.number().int().positive(),
  /** Cache codes — handy for showing in the UI. */
  fromCode: z.string(),
  toCode: z.string(),
  haversineM: z.number().nonnegative(),
  /** OSRM's reply. `null` when OSRM says NoRoute. */
  route: z
    .object({
      meters: z.number().nonnegative(),
      seconds: z.number().nonnegative(),
      geometry: GeoJsonLineString,
    })
    .nullable(),
});
export type TestRouteResponse = z.infer<typeof TestRouteResponse>;

export const WalkingGraphResponse = z.object({
  nodes: z.array(WalkingGraphNode),
  edges: z.array(WalkingGraphEdge),
  stats: z.object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    isolatedCount: z.number().int().nonnegative(),
    suspiciousCount: z.number().int().nonnegative(),
    medianEdgeM: z.number().nonnegative(),
    maxEdgeM: z.number().nonnegative(),
    /**
     * Median walkingM/haversineM ratio over non-suspicious edges. ~1.2-1.5
     * is healthy urban; > 2.5 usually means OSRM is detouring around big
     * gaps in the foot graph (incomplete extract, missing pedestrian
     * crossings, fenced industrial areas) — the classic cause of "two near
     * caches refuse to cluster" cases.
     */
    medianDetourRatio: z.number().nonnegative(),
    /** Count of edges with walkingM/haversineM > 4 — outright bad routes. */
    highDetourCount: z.number().int().nonnegative(),
    /**
     * Heuristic flag: true when the planner is likely working off poor OSRM
     * coverage. Set when median ratio > 2.5 OR > 25% of edges have ratio > 4.
     * The UI surfaces this so the user knows to investigate the OSRM extract
     * (often switching `OSRM_REGION` to `OSRM_REGIONS=…,…` fixes it).
     */
    coverageWarning: z.boolean(),
  }),
});
export type WalkingGraphResponse = z.infer<typeof WalkingGraphResponse>;
