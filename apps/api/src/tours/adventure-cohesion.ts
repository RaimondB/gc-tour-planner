// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Routing } from "@gctp/shared";

/**
 * A candidate Adventure Lab to (maybe) pull into a cluster: its id and the
 * stage cache ids that would be added. Atomic — accepted whole or not at all.
 */
export interface CandidateAdventure {
  adventureId: string;
  stageIds: number[];
}

export interface ReachabilityPartition {
  /** Stage ids of adventures that cohere with the cluster — safe to add. */
  acceptedStageIds: number[];
  /** Adventures that don't connect to the cluster within `maxLinkMeters`. */
  rejected: { adventureId: string; stageIds: number[] }[];
}

/**
 * Gate candidate adventures by **walking-connectivity to the cluster**, the same
 * cohesion rule Pass-1's walking graph enforces (FR-T13 / follow-up #1).
 *
 * Build the graph over the matrix node set where an edge `(a,b)` exists iff the
 * walking distance `min(a→b, b→a)` is finite and `≤ maxLinkMeters`. Starting from
 * the cluster's existing caches (`seedIds`), an adventure **passes** iff **every**
 * one of its stages lands in the cluster's reachable component — so a stage that
 * only connects through other (near) stages of the same adventure still passes,
 * but one fully across a barrier rejects the whole adventure.
 *
 * Pure: the caller injects the (cache-aware) matrix, so this is unit-testable
 * without OSRM or a DB. The matrix must cover every `seedIds` + candidate stage
 * id; ids absent from `matrix.cacheIds` are treated as unreachable.
 */
export function partitionAdventuresByReachability(args: {
  seedIds: readonly number[];
  candidates: readonly CandidateAdventure[];
  matrix: Routing.Matrix;
  maxLinkMeters: number;
}): ReachabilityPartition {
  const { seedIds, candidates, matrix, maxLinkMeters } = args;

  const idToIdx = new Map<number, number>();
  matrix.cacheIds.forEach((id, i) => idToIdx.set(id, i));

  // Walking distance between two cache ids, honest about direction + unrouteable
  // pairs. Returns +∞ when either id is missing from the matrix.
  const linkMeters = (a: number, b: number): number => {
    const i = idToIdx.get(a);
    const j = idToIdx.get(b);
    if (i === undefined || j === undefined) return Number.POSITIVE_INFINITY;
    const ab = matrix.legs[i]?.[j]?.meters;
    const ba = matrix.legs[j]?.[i]?.meters;
    const best = Math.min(
      ab ?? Number.POSITIVE_INFINITY,
      ba ?? Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(best) ? best : Number.POSITIVE_INFINITY;
  };

  // BFS the cluster's reachable component over the maxLinkMeters graph. Only the
  // seed ids + candidate stage ids are relevant nodes (other matrix entries, if
  // any, can't pull a stage in without also linking to a relevant node).
  const nodes = [
    ...new Set<number>([...seedIds, ...candidates.flatMap((c) => c.stageIds)]),
  ];
  const reachable = new Set<number>(seedIds);
  const frontier = [...seedIds];
  while (frontier.length > 0) {
    const cur = frontier.pop()!;
    for (const next of nodes) {
      if (reachable.has(next)) continue;
      if (linkMeters(cur, next) <= maxLinkMeters) {
        reachable.add(next);
        frontier.push(next);
      }
    }
  }

  const acceptedStageIds: number[] = [];
  const rejected: { adventureId: string; stageIds: number[] }[] = [];
  for (const adv of candidates) {
    if (adv.stageIds.every((id) => reachable.has(id))) {
      acceptedStageIds.push(...adv.stageIds);
    } else {
      rejected.push({ adventureId: adv.adventureId, stageIds: adv.stageIds });
    }
  }
  return { acceptedStageIds, rejected };
}
