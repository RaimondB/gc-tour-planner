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

/**
 * Keep only the **largest walk-connected component** of a candidate set, and
 * report the rest as dropped. A planner that receives a disconnected candidate
 * set (two groups with no `≤ maxLinkMeters` chain between them — e.g. across a
 * river/motorway) can't route them into one foot loop: the OSRM leg between the
 * groups is `null`, which poisons the tour length (∞) and triggers a runaway
 * over-trim. Pre-filtering to one component up front prevents that; the dropped
 * minority is surfaced as `unreachable` (FR-T13).
 *
 * `metersMatrix` is indexed like `ids` (`metersMatrix[i][j]` = `ids[i]→ids[j]`,
 * `null` when OSRM couldn't route it). An edge exists iff
 * `min(i→j, j→i)` is finite **and** `≤ maxLinkMeters` — the same linking cap as
 * Pass-1's walking graph, so a component connected only by long/`null` legs
 * splits. Ties (equal node counts) break on the lowest member id for
 * determinism. Pure + unit-testable.
 */
export function largestConnectedComponent(
  ids: readonly number[],
  metersMatrix: readonly (readonly (number | null)[])[],
  maxLinkMeters: number,
): { keptIds: number[]; droppedIds: number[] } {
  const n = ids.length;
  if (n <= 1) return { keptIds: [...ids], droppedIds: [] };

  const linked = (i: number, j: number): boolean => {
    const ab = metersMatrix[i]?.[j];
    const ba = metersMatrix[j]?.[i];
    const best = Math.min(
      ab == null ? Number.POSITIVE_INFINITY : ab,
      ba == null ? Number.POSITIVE_INFINITY : ba,
    );
    return Number.isFinite(best) && best <= maxLinkMeters;
  };

  // BFS each unvisited node into its component (by index into `ids`).
  const compOf = new Array<number>(n).fill(-1);
  const components: number[][] = [];
  for (let s = 0; s < n; s += 1) {
    if (compOf[s] !== -1) continue;
    const comp: number[] = [];
    const stack = [s];
    compOf[s] = components.length;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (let k = 0; k < n; k += 1) {
        if (compOf[k] === -1 && linked(cur, k)) {
          compOf[k] = components.length;
          stack.push(k);
        }
      }
    }
    components.push(comp);
  }

  // Pick the largest; tie-break on the lowest member id (deterministic).
  let best = components[0]!;
  let bestMinId = Math.min(...best.map((i) => ids[i]!));
  for (const comp of components.slice(1)) {
    const minId = Math.min(...comp.map((i) => ids[i]!));
    if (
      comp.length > best.length ||
      (comp.length === best.length && minId < bestMinId)
    ) {
      best = comp;
      bestMinId = minId;
    }
  }

  const keep = new Set(best.map((i) => ids[i]!));
  return {
    keptIds: ids.filter((id) => keep.has(id)),
    droppedIds: ids.filter((id) => !keep.has(id)),
  };
}
