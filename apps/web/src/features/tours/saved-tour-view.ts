// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CacheSummaryDTO, CacheType } from "@gctp/shared/caches";

/**
 * Build map-ready cache summaries from a saved tour's denormalised snapshots.
 * Snapshots carry only identity + location, so the live-only fields (found,
 * disabled, solved, stages, parking, tool) default off — enough to render the
 * marker when re-opening a saved tour, even if the cache row is gone (FR-P1.3).
 */
export function tourCachesToSummaries(
  snaps: readonly {
    id: number;
    code: string;
    type: string;
    name: string;
    location: CacheSummaryDTO["location"];
  }[],
): CacheSummaryDTO[] {
  return snaps.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    type: s.type as CacheType,
    location: s.location,
    disabled: false,
    solved: false,
    foundByMe: false,
    stageCount: 0,
    parkingPoints: [],
    requiresTool: false,
    // Snapshots don't store the adventure deep-link; a live re-fetch repopulates
    // it. Null is fine — the marker still renders for a saved Adventure Lab stop.
    adventureId: null,
  }));
}
