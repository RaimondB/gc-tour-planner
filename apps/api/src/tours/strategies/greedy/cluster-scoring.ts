// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches, Tours } from "@gctp/shared";
import { haversineMeters } from "./equirectangular.js";

/** Radius around a cache for "parking present" — same as the legacy planner. */
const PARKING_PRESENCE_RADIUS_M = 500;

export interface ScoreClusterInput {
  caches: readonly Caches.CacheDTO[];
  /** MST length (m) — used for density + budgetFit terms. */
  mstLengthMeters: number;
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
  const density = mstLengthMeters > 0 ? caches.length / mstLengthMeters : 0;
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

  // Budget fit: Gaussian peak at MST = budget.
  const r =
    (mstLengthMeters - distanceBudgetMeters) / distanceBudgetMeters;
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
