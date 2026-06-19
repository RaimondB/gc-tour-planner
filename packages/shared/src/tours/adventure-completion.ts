// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** Minimal cache shape the completion summary needs (subset of CacheSummaryDTO). */
export interface AdventureStageLike {
  adventureId: string | null;
  stageTotal: number | null;
  name: string;
}

export interface AdventureCompletion {
  adventureId: string;
  /** Adventure title, derived from the stage name (`"<title> : S1 <stage>"`). */
  name: string;
  /** Stages of this adventure included in the routed loop. */
  included: number;
  /** Stages the planner dropped (budget trim) — explains a partial adventure. */
  dropped: number;
  /** Total stages in the adventure (Lab2Gpx `stagesTotal`); null if unknown. */
  total: number | null;
}

/** Strip the `" : S{n} …"` stage suffix to recover the adventure title. */
function adventureTitle(stageName: string): string {
  const cut = stageName.split(/\s*:\s*S\d/i)[0];
  return (cut ?? stageName).trim() || stageName;
}

/**
 * Summarize, per Adventure, how much of it a planned loop covers — the answer to
 * "can I complete the whole Adventure on this tour?". Groups the loop's caches
 * (and the planner-dropped ones) by `adventureId`; non-AL caches are ignored.
 * Pure + dependency-free so it's unit-testable and reusable across views.
 *
 * Sorted: incomplete adventures first (most missing first), then by name.
 */
export function summarizeAdventureCompletion(
  orderedCacheIds: readonly number[],
  droppedCacheIds: readonly number[],
  cacheById: ReadonlyMap<number, AdventureStageLike>,
): AdventureCompletion[] {
  const byAdventure = new Map<string, AdventureCompletion>();

  const bump = (id: number, key: "included" | "dropped") => {
    const c = cacheById.get(id);
    if (!c || c.adventureId == null) return;
    let entry = byAdventure.get(c.adventureId);
    if (!entry) {
      entry = {
        adventureId: c.adventureId,
        name: adventureTitle(c.name),
        included: 0,
        dropped: 0,
        total: null,
      };
      byAdventure.set(c.adventureId, entry);
    }
    entry[key] += 1;
    if (entry.total == null && c.stageTotal != null) entry.total = c.stageTotal;
  };

  for (const id of orderedCacheIds) bump(id, "included");
  for (const id of droppedCacheIds) bump(id, "dropped");

  const missing = (e: AdventureCompletion) =>
    e.total != null ? e.total - e.included : 0;

  return [...byAdventure.values()].sort(
    (a, b) => missing(b) - missing(a) || a.name.localeCompare(b.name),
  );
}
