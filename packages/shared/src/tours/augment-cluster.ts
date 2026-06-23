// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";

/**
 * Augment a chosen cluster with nearby Adventure Lab stages (FR-I15). The
 * server does a *small* Lab2Gpx fetch around the cluster's extent, imports the
 * stages, and returns the cluster's cache ids expanded with the nearby labs —
 * the user reviews them, then plans the augmented cluster. Explicit + small by
 * design (clustering itself never fetches; the heavy whole-area import is a
 * separate admin background job).
 */
export const AugmentClusterInput = z.object({
  /** The cluster's current cache ids (the candidate the user selected). */
  cacheIds: z.array(z.number().int().positive()).min(1).max(50),
  /**
   * Walking-cohesion cap (metres): a nearby adventure is only added if its stages
   * connect to the cluster's walking graph within this distance (FR-T13 / cohesion
   * gate). Mirrors `PlanLoopInput.maxLinkMeters`; defaults to its default so older
   * clients keep working.
   */
  maxLinkMeters: z.number().int().positive().max(5_000).default(1_500),
});
export type AugmentClusterInput = z.infer<typeof AugmentClusterInput>;

export const AugmentClusterResult = z.object({
  /** Original ids plus nearby Adventure Lab stage ids, capped at the loop max. */
  cacheIds: z.array(z.number().int().positive()),
  /** How many lab stages were added (0 when the admin flag is off or none found). */
  added: z.number().int().nonnegative(),
  /**
   * How many nearby adventures were found but **not** added — because they don't
   * connect to the cluster's walking graph within `maxLinkMeters`, or wouldn't fit
   * the loop cap. Lets the UI say "N nearby adventures didn't fit this cluster".
   */
  skipped: z.number().int().nonnegative().default(0),
});
export type AugmentClusterResult = z.infer<typeof AugmentClusterResult>;
