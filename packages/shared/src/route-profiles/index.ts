// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import {
  CacheType,
  FULL_RATING_RANGE,
  MultiSubtypeFilter,
  RatingRange,
} from "../caches/index.js";
import { LanduseKind } from "../landuse/index.js";
import {
  ParkingAccessChip,
  ParkingFeeFilter,
} from "../parking-facilities/index.js";
import {
  ClusteringStrategyName,
  StartPreference,
} from "../tours/plan-input.js";

/**
 * Route profiles (ADR-0039, FR-T19): named planning presets shared by the
 * classic cluster planner and the ad-hoc walk. A profile holds every planning
 * setting except the search centre and map-display toggles. `settings` is stored verbatim as
 * JSONB; every field has a default so a profile saved before a field existed
 * still parses into a complete object. A breaking change bumps `version` and
 * migrates in `RouteProfileSettings`'s preprocess.
 */

/** Search area (the centre is "where am I", never part of a profile). */
export const RouteProfileSearch = z.object({
  radiusM: z.number().int().min(500).max(50_000).default(5_000),
});

export const RouteProfileFilters = z.object({
  /** Empty = any type. */
  types: z.array(CacheType).default([]),
  multiSubtype: MultiSubtypeFilter.default("all"),
  excludeFound: z.boolean().default(false),
  includeDisabled: z.boolean().default(false),
  hideToolCaches: z.boolean().default(false),
  solvedMysteriesOnly: z.boolean().default(false),
  /** Landuse hard filter: cache must lie in one of these kinds. Empty = off. */
  contexts: z.array(LanduseKind).default([]),
  difficulty: RatingRange.default(FULL_RATING_RANGE),
  terrain: RatingRange.default(FULL_RATING_RANGE),
  excludeSavedTourCaches: z.boolean().default(true),
});

export const RouteProfileAdventures = z.object({
  /** Adventure Labs take part at all (cluster forming, walk candidates). */
  include: z.boolean().default(true),
  /** Plan an Adventure Lab whole or not at all. */
  keepTogether: z.boolean().default(true),
  /** Let an adventure's stages interleave with other caches. */
  interleave: z.boolean().default(true),
});

export const RouteProfileObjective = z.object({
  landuseProfileId: z.guid().nullable().default(null),
  landuseWeight: z.number().min(0).max(5).default(1),
  /** Prefer clusters near the centre of the search area. */
  centerProximityWeight: z.number().min(0).max(5).default(1),
  /** Reward a mix of cache types and difficulty bands. 0 = off. */
  varietyWeight: z.number().min(0).max(5).default(0),
  /** Types to favour, e.g. Adventure Labs or multis. */
  preferredTypes: z.array(CacheType).default([]),
  preferredWeight: z.number().min(0).max(5).default(1),
});

export const RouteProfileTime = z.object({
  visitMinutes: z.number().int().min(0).max(120).default(5),
  /**
   * Per-type visit-time overrides; absent types use visitMinutes. Adventure
   * Lab stages always use alStageVisitMinutes (see visitMinutesFor).
   */
  visitMinutesByType: z
    .partialRecord(CacheType, z.number().int().min(0).max(240))
    .default({}),
  alStageVisitMinutes: z.number().int().min(0).max(60).default(2),
  toolBonusMinutes: z.number().int().min(0).max(60).default(5),
  walkingKmh: z.number().min(1).max(10).default(5),
});

export const RouteProfileBudget = z.object({
  distanceBudgetMeters: z.number().int().min(1_000).max(25_000).default(8_000),
  /**
   * Time available (minutes); null = no time limit. The planner's time budget
   * is this minus bufferMinutes; the ad-hoc walk prefills it as the duration.
   */
  durationMinutes: z.number().int().min(15).max(720).nullable().default(null),
  /** Safety margin kept free inside durationMinutes. */
  bufferMinutes: z.number().int().min(0).max(120).default(10),
});

export const RouteProfileParking = z.object({
  startPreference: StartPreference.default("auto"),
  osmAccess: z.array(ParkingAccessChip).default(["yes", "customers"]),
  osmFee: ParkingFeeFilter.default("any"),
});

/** Expert tuning of cluster discovery and loop shaping. */
export const RouteProfileAdvanced = z.object({
  minClusterSize: z.number().int().min(2).max(50).default(8),
  maxLinkMeters: z.number().int().min(200).max(5_000).default(1_500),
  clusteringStrategy: ClusteringStrategyName.default("hdbscan-star"),
  topNClusters: z.number().int().min(1).max(20).default(5),
  fringeTrimMeters: z.number().int().min(100).max(3_000).default(500),
});

export const RouteProfileSettings = z.object({
  version: z.literal(1).default(1),
  search: RouteProfileSearch.prefault({}),
  filters: RouteProfileFilters.prefault({}),
  adventures: RouteProfileAdventures.prefault({}),
  objective: RouteProfileObjective.prefault({}),
  time: RouteProfileTime.prefault({}),
  budget: RouteProfileBudget.prefault({}),
  parking: RouteProfileParking.prefault({}),
  advanced: RouteProfileAdvanced.prefault({}),
});
export type RouteProfileSettings = z.infer<typeof RouteProfileSettings>;
/** What a client may send: any subset; the server fills defaults. */
export type RouteProfileSettingsInput = z.input<typeof RouteProfileSettings>;

/** Planner time budget a profile implies: duration minus buffer, or none. */
export function timeBudgetMinutes(
  budget: RouteProfileSettings["budget"],
): number | undefined {
  if (budget.durationMinutes === null) return undefined;
  return Math.max(1, budget.durationMinutes - budget.bufferMinutes);
}

export const RouteProfile = z.object({
  id: z.guid(),
  /** null = system preset (read-only). */
  ownerId: z.guid().nullable(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable(),
  settings: RouteProfileSettings,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type RouteProfile = z.infer<typeof RouteProfile>;

export const RouteProfilesResponse = z.object({
  profiles: z.array(RouteProfile),
});
export type RouteProfilesResponse = z.infer<typeof RouteProfilesResponse>;

/** Body of POST /route-profiles and PUT /route-profiles/:id. */
export const SaveRouteProfileInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().default(null),
  settings: RouteProfileSettings,
});
export type SaveRouteProfileInput = z.infer<typeof SaveRouteProfileInput>;
