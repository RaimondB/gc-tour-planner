// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CacheType } from "@gctp/shared/caches";
import type { LanduseKind } from "@gctp/shared/landuse";

export interface SearchParams {
  center: [number, number]; // [lng, lat]
  radiusM: number;
  types: CacheType[]; // empty = "any type"
  excludeFound: boolean;
  /** Hard filter: cache must lie inside at least one polygon of these kinds. */
  contexts: LanduseKind[];
  /** Toggle the semi-transparent landuse overlay on the map. */
  showLanduse: boolean;
  /**
   * Include caches the owner has temporarily disabled (FR-I10).
   * Default false — server hides them. When true, the map renders
   * them at 50 % opacity with a "Z" overlay (geocaching.com style).
   */
  includeDisabled: boolean;
  /**
   * FR-SF2 Multi sub-filter — when "Multi" is in `types`, this
   * narrows to "all" / mini-multis (≤2 stages) / full multis (≥3
   * stages). Applied client-side after fetch — no extra server
   * round-trip.
   */
  multiSubtype: "all" | "mini" | "full";
  /**
   * FR-SF6 — hide caches that need physical equipment. Reads
   * `attributeIds` + `descriptionHints` from each CacheDTO and runs
   * `hasToolRequirement` client-side. Default false (show
   * everything).
   */
  hideToolCaches: boolean;
}

export const DEFAULT_SEARCH: SearchParams = {
  center: [5.1214, 52.0907], // Utrecht — placeholder until "use my location"
  radiusM: 5_000,
  types: [],
  excludeFound: false,
  contexts: [],
  showLanduse: false,
  includeDisabled: false,
  multiSubtype: "all",
  hideToolCaches: false,
};

/**
 * Convert a (center, radiusM) into a bbox padded by ~20% so the landuse layer
 * extends beyond the radius circle and the user can pan a little without an
 * immediate refetch.
 */
export function radiusBbox(
  center: [number, number],
  radiusM: number,
): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  const [lng, lat] = center;
  const padded = radiusM * 1.2;
  const earthR = 6_378_137;
  const dLat = (padded / earthR) * (180 / Math.PI);
  const dLng =
    ((padded / earthR) * (180 / Math.PI)) / Math.cos((lat * Math.PI) / 180);
  return {
    minLng: lng - dLng,
    minLat: lat - dLat,
    maxLng: lng + dLng,
    maxLat: lat + dLat,
  };
}
