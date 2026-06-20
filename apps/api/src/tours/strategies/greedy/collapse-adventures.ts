// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Caches } from "@gctp/shared";

/**
 * Collapse the stages of each Adventure Lab into a SINGLE representative node so
 * Pass-1 clustering treats an adventure as one place — not 5-10 near-co-located
 * caches that form their own dense micro-cluster (FR-I17). The chosen cluster's
 * ids are expanded back to every stage on output, so Pass-2 still routes the
 * whole adventure (with its own atomic/contiguity handling).
 *
 * The representative is the stage **nearest the adventure's centroid** (the
 * medoid). We use a real stage — not a synthetic centroid point — because the
 * walking graph and OSRM operate on actual cache rows; the medoid sits within
 * metres of the centroid, so the clustering node is effectively "the middle of
 * the adventure" while remaining routable. (Lab2Gpx exposes no adventure-level
 * coordinate, so an anchor has to be derived from the stages — see ADR-0034.)
 *
 * Pure + dependency-free for unit-testing.
 */
export interface AdventureCollapse {
  /** Non-AL caches unchanged + one representative per adventure. */
  collapsed: Caches.CacheDTO[];
  /**
   * Representative cache id → all of that adventure's stage ids (incl. the rep),
   * ascending. Only adventures with ≥2 stages get an entry; everything else
   * (non-AL, single-stage adventures) expands to itself.
   */
  expansion: Map<number, number[]>;
}

export function collapseAdventures(
  caches: readonly Caches.CacheDTO[],
): AdventureCollapse {
  const groups = new Map<string, Caches.CacheDTO[]>();
  const passthrough: Caches.CacheDTO[] = [];
  for (const c of caches) {
    if (c.type === "Adventure Lab" && c.adventureId) {
      const arr = groups.get(c.adventureId);
      if (arr) arr.push(c);
      else groups.set(c.adventureId, [c]);
    } else {
      passthrough.push(c);
    }
  }

  if (groups.size === 0) {
    return { collapsed: [...passthrough], expansion: new Map() };
  }

  const collapsed = [...passthrough];
  const expansion = new Map<number, number[]>();
  for (const members of groups.values()) {
    if (members.length === 1) {
      // A lone stage already is its own node; no collapse, no expansion entry.
      collapsed.push(members[0]!);
      continue;
    }
    // Centroid of the stages, then the member nearest it (medoid). Squared
    // planar distance is enough to pick the nearest within a sub-km adventure;
    // ties break on the lowest id for determinism.
    let sumLng = 0;
    let sumLat = 0;
    for (const m of members) {
      sumLng += m.location.coordinates[0]!;
      sumLat += m.location.coordinates[1]!;
    }
    const cLng = sumLng / members.length;
    const cLat = sumLat / members.length;
    let rep = members[0]!;
    let bestD = Number.POSITIVE_INFINITY;
    for (const m of members) {
      const dx = m.location.coordinates[0]! - cLng;
      const dy = m.location.coordinates[1]! - cLat;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && m.id < rep.id)) {
        bestD = d;
        rep = m;
      }
    }
    collapsed.push(rep);
    expansion.set(
      rep.id,
      members.map((m) => m.id).sort((a, b) => a - b),
    );
  }
  return { collapsed, expansion };
}

/**
 * Expand a list of (possibly representative) cache ids back to the full set of
 * stage ids, using the map from {@link collapseAdventures}. Ids with no
 * expansion entry pass through unchanged. Order follows `ids`, with each rep
 * replaced inline by its ascending member ids.
 */
export function expandAdventureIds(
  ids: readonly number[],
  expansion: ReadonlyMap<number, readonly number[]>,
): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const members = expansion.get(id);
    if (members && members.length > 0) out.push(...members);
    else out.push(id);
  }
  return out;
}
