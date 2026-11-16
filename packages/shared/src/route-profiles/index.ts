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

/**
 * Route profiles (ADR-0039, FR-T19): named planning presets shared by the
 * classic cluster planner and the ad-hoc walk. `settings` is stored verbatim as
 * JSONB; every field has a default so a profile saved before a field existed
 * still parses into a complete object. A breaking change bumps `version` and
 * migrates in `RouteProfileSettings`'s preprocess.
 */

export const RouteProfileFilters = z.object({
  /** Empty = any type. */
  types: z.array(CacheType).default([]),
  multiSubtype: MultiSubtypeFilter.default("all"),
  hideToolCaches: z.boolean().default(false),
  solvedMysteriesOnly: z.boolean().default(false),
  /** Landuse hard filter: cache must lie in one of these kinds. Empty = off. */
  contexts: z.array(LanduseKind).default([]),
  difficulty: RatingRange.default(FULL_RATING_RANGE),
  terrain: RatingRange.default(FULL_RATING_RANGE),
  includeAdventureLabs: z.boolean().default(true),
  excludeSavedTourCaches: z.boolean().default(true),
});

export const RouteProfileAdventures = z.object({
  /** Plan an Adventure Lab whole or not at all. */
  keepTogether: z.boolean().default(true),
  /** Let an adventure's stages interleave with other caches. */
  interleave: z.boolean().default(true),
});

export const RouteProfileObjective = z.object({
  landuseProfileId: z.guid().nullable().default(null),
  landuseWeight: z.number().min(0).max(5).default(1),
  /** Reward a mix of cache types / D-T bands (ad-hoc walk). */
  varietyWeight: z.number().min(0).max(5).default(1),
  /** Types to favour (ad-hoc walk), e.g. Adventure Labs or multis. */
  preferredTypes: z.array(CacheType).default([]),
  preferredWeight: z.number().min(0).max(5).default(1),
});

export const RouteProfileTime = z.object({
  visitMinutes: z.number().int().min(0).max(120).default(5),
  /** Per-type visit-time overrides (ad-hoc walk); absent types use visitMinutes. */
  visitMinutesByType: z
    .partialRecord(CacheType, z.number().int().min(0).max(240))
    .default({}),
  alStageVisitMinutes: z.number().int().min(0).max(60).default(2),
  toolBonusMinutes: z.number().int().min(0).max(60).default(5),
  walkingKmh: z.number().min(1).max(10).default(5),
  /** Safety margin before the walk deadline (ad-hoc walk). */
  bufferMinutes: z.number().int().min(0).max(120).default(10),
});

export const RouteProfileBudget = z.object({
  /** Classic planner distance budget. */
  distanceBudgetMeters: z.number().int().positive().max(25_000).default(8_000),
  /** Prefilled ad-hoc walk duration; null = ask every time. */
  defaultDurationMinutes: z
    .number()
    .int()
    .min(15)
    .max(720)
    .nullable()
    .default(null),
});

export const RouteProfileSettings = z.object({
  version: z.literal(1).default(1),
  filters: RouteProfileFilters.prefault({}),
  adventures: RouteProfileAdventures.prefault({}),
  objective: RouteProfileObjective.prefault({}),
  time: RouteProfileTime.prefault({}),
  budget: RouteProfileBudget.prefault({}),
});
export type RouteProfileSettings = z.infer<typeof RouteProfileSettings>;
/** What a client may send: any subset; the server fills defaults. */
export type RouteProfileSettingsInput = z.input<typeof RouteProfileSettings>;

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
