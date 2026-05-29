// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches, Tours } from "@gctp/shared";
import { haversineMeters } from "./equirectangular.js";

/** Radius around a cache for "parking present" — same as the legacy planner. */
const PARKING_PRESENCE_RADIUS_M = 500;

export interface ScoreClusterInput {
  caches: readonly Caches.CacheDTO[];
  /** MST length (m) — used by the density term as a compactness proxy. */
  mstLengthMeters: number;
  /**
   * Estimated closed-loop tour length (m) — NN+2-opt on the same distance
   * lookup the MST uses. Replaces the MST in the `budgetFit` term: MST is
   * a lower bound that dramatically undershoots the actual TSP tour for
   * thin / chained clusters (a 14-cache cluster with MST 3.3 km can yield
   * a 17 km tour). Using the TSP estimate makes the budgetFit penalty
   * actually reflect what the user gets in Pass 2.
   */
  estimatedTourMeters: number;
  /** User's distance budget in metres — feeds the Gaussian budgetFit term. */
  distanceBudgetMeters: number;
  softPrefs: Tours.SoftPreferences;
  /** cache_landuse lookup: cache id → list of kinds it sits inside. */
  landuseKindsByCacheId: ReadonlyMap<number, readonly string[]>;
  /** Kinds the active landuse profile considers "preferred". Empty → term zeroes out. */
  preferredLanduseKinds: readonly string[];
  /** Weight applied to `landuseMatch`. Defaults to 1 when a profile is selected. */
  landuseWeight: number;
}

export interface ClusterScore {
  total: number;
  breakdown: Record<string, number>;
}

/**
 * Compute one cluster's score from its caches + soft preferences. Returns the
 * `total` (sum of weighted terms) and the `breakdown` (one entry per term)
 * for the wire DTO.
 *
 * The legacy terms (clusterDensity, parkingPresence, budgetFit, terrainMatch,
 * difficultyMatch) keep their existing math so a re-rank on the same pool is
 * still comparable. Two new terms ship with the Pass 1 redesign:
 *
 *   - `attrPrefMatch` — mean over caches of Σ prefs[attr] · (cache has attr).
 *     Mean (not sum) so a 30-cache cluster does not crowd out a 10-cache one
 *     with the same per-cache attribute richness.
 *
 *   - `landuseMatch` — fraction of caches whose `cache_landuse` row has at
 *     least one kind in `preferredLanduseKinds`, times `landuseWeight`. Zero
 *     when the user did not select a landuse profile, or when the lookup is
 *     empty for the region (graceful degradation per plan).
 */
export function scoreCluster(input: ScoreClusterInput): ClusterScore {
  const {
    caches,
    mstLengthMeters,
    distanceBudgetMeters,
    softPrefs,
    landuseKindsByCacheId,
    preferredLanduseKinds,
    landuseWeight,
  } = input;

  const breakdown: Record<string, number> = {};

  // Density: more caches per unit MST length → more cohesive cluster.
  // Expressed as caches per 100 m of MST so the value lands in roughly
  // the same 0..1+ range as the other terms (parkingPresence is 0/1,
  // budgetFit and landuseMatch are 0..1). Without the 100× rescale this
  // term sat around ~0.003 and never moved the ranking — the user-
  // configurable `clusterDensityWeight` lets the user tune from there.
  const density =
    mstLengthMeters > 0 ? (caches.length * 100) / mstLengthMeters : 0;
  breakdown.clusterDensity = density * softPrefs.clusterDensityWeight;

  // Parking presence: any cache within 500 m of an owner-supplied parking waypoint.
  const parkingPresence = caches.some((c) =>
    c.parkingPoints.some(
      (p) =>
        haversineMeters(
          [c.location.coordinates[0]!, c.location.coordinates[1]!],
          p,
        ) <= PARKING_PRESENCE_RADIUS_M,
    ),
  )
    ? 1
    : 0;
  breakdown.parkingPresence = parkingPresence;

  // Loop shape: detect linear-chain clusters that require retracing
  // the same path twice (walk to one end and back). The TSP/MST ratio
  // is the classic geometric signal — close to 1.0 for a circular blob
  // (you can short-cut between neighbours), close to 2.0 for a string
  // of points along a line (you must traverse every MST edge twice on
  // a closed loop). Our `estimatedTourMeters` carries a 1.4×
  // haversine→walking inflation while MST is raw haversine, so the
  // natural thresholds shift: ratio = 1.4 ≈ compact ideal, ratio = 2.8
  // ≈ pure linear chain. Score is a linear ramp between those.
  if (input.estimatedTourMeters > 0 && mstLengthMeters > 0) {
    const ratio = input.estimatedTourMeters / mstLengthMeters;
    const COMPACT_RATIO = 1.4;
    const CHAIN_RATIO = 2.8;
    const t = (CHAIN_RATIO - ratio) / (CHAIN_RATIO - COMPACT_RATIO);
    breakdown.loopShape = Math.max(0, Math.min(1, t));
  } else {
    breakdown.loopShape = 0;
  }

  // Budget fit: Gaussian peak when the estimated TSP closed loop matches
  // the user's distance budget. Uses `estimatedTourMeters` (NN+2-opt on
  // the cluster's distance lookup) rather than MST — MST is a lower
  // bound that undershoots by 2-5× on thin / chained clusters and lets
  // 17 km tours rank as if they were 3 km tours.
  const tourMeters =
    input.estimatedTourMeters > 0 ? input.estimatedTourMeters : mstLengthMeters;
  const r = (tourMeters - distanceBudgetMeters) / distanceBudgetMeters;
  breakdown.budgetFit =
    Math.exp(-(r * r)) * softPrefs.loopCompactnessWeight;

  // Terrain / difficulty target preferences (legacy).
  if (softPrefs.terrainTarget) {
    const m = mean(
      caches.map((c) => safeFloat(c.terrain) ?? softPrefs.terrainTarget!.value),
    );
    breakdown.terrainMatch = gaussianMatch(
      m,
      softPrefs.terrainTarget.value,
      softPrefs.terrainTarget.tolerance,
      softPrefs.terrainTarget.weight,
    );
  }
  if (softPrefs.difficultyTarget) {
    const m = mean(
      caches.map(
        (c) =>
          safeFloat(c.difficulty) ?? softPrefs.difficultyTarget!.value,
      ),
    );
    breakdown.difficultyMatch = gaussianMatch(
      m,
      softPrefs.difficultyTarget.value,
      softPrefs.difficultyTarget.tolerance,
      softPrefs.difficultyTarget.weight,
    );
  }

  // New: attribute preferences. Mean over caches of Σ prefs[attr]·indicator.
  const attrPrefs = softPrefs.attributePreferences ?? {};
  if (Object.keys(attrPrefs).length > 0) {
    let perCacheSum = 0;
    for (const c of caches) {
      let cs = 0;
      for (const attrId of c.attributeIds) {
        const w = attrPrefs[String(attrId)];
        if (typeof w === "number") cs += w;
      }
      perCacheSum += cs;
    }
    breakdown.attrPrefMatch =
      caches.length > 0 ? perCacheSum / caches.length : 0;
  }

  // New: landuse match. Fraction of caches inside a preferred polygon.
  if (preferredLanduseKinds.length > 0 && landuseKindsByCacheId.size > 0) {
    const preferred = new Set(preferredLanduseKinds);
    let hits = 0;
    for (const c of caches) {
      const kinds = landuseKindsByCacheId.get(c.id) ?? [];
      if (kinds.some((k) => preferred.has(k))) hits += 1;
    }
    const fraction = caches.length > 0 ? hits / caches.length : 0;
    breakdown.landuseMatch = fraction * landuseWeight;
  }

  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { total, breakdown };
}

/* --- helpers --------------------------------------------------------------- */

function gaussianMatch(
  observed: number,
  target: number,
  tolerance: number,
  weight: number,
): number {
  const z = (observed - target) / Math.max(tolerance, 1e-6);
  return weight * Math.exp(-(z * z));
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * CacheDTO.difficulty/terrain come back as `number | null` from the API but
 * the wire schema allows string-typed reads from the DB. Coerce defensively.
 */
function safeFloat(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? v : Number.parseFloat(String(v));
}
