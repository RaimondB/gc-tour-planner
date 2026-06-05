// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LanduseKind } from "../landuse/index.js";

/**
 * Saved soft-preference profiles for landuse-aware cluster scoring
 * (M5-β). A profile is just a set of canonical landuse kinds the user
 * wants the planner to reward; the scoring math lives in
 * `apps/api/src/tours/strategies/greedy/cluster-scoring.ts` under
 * `landuseMatch` (fraction of caches whose `cache_landuse` row contains
 * a preferred kind).
 *
 * Per-kind weights are deferred: keeping the wire schema minimal lets us
 * add weight support later by widening the JSON shape without breaking
 * existing clients.
 */
export const LanduseProfile = z.object({
  id: z.uuid(),
  ownerId: z.uuid().nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  /** Canonical kinds the profile rewards. Must be a subset of LANDUSE_KINDS. */
  kinds: z.array(LanduseKind).min(1),
  createdAt: z.coerce.date(),
});
export type LanduseProfile = z.infer<typeof LanduseProfile>;

export const LanduseProfilesResponse = z.object({
  profiles: z.array(LanduseProfile),
});
export type LanduseProfilesResponse = z.infer<typeof LanduseProfilesResponse>;
