// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pure TSP-loop primitives shared by the two side-by-side loop solvers:
 * `solveTwoOpt` (shortest distance, ./two-opt.ts) and `solveLowOverlapLoop`
 * (low retracing, ./low-overlap-loop.ts).
 *
 * These are deliberately duplicated from `two-opt.ts` rather than extracted out
 * of it: the shortest-distance solver is the default, proven path and is kept
 * byte-for-byte unchanged (its tests are the regression guard). The helpers
 * here are tiny, mathematically fixed, and exercised by the low-overlap solver's
 * own tests.
 */

import type { DistanceMatrix } from "./two-opt.js";

/** Maximum 2-opt iterations before bailing out. With N ≤ 50 we converge fast. */
export const MAX_ITERATIONS = 1_000;
/** Maximum Or-opt iterations before bailing out (independent budget). */
export const MAX_OR_OPT_ITERATIONS = 1_000;
/** Hard cap on outer VND rounds — guarantees termination on FP noise. */
export const MAX_VND_ROUNDS = 64;
/** Or-opt chain lengths considered (move 1, 2, or 3 consecutive nodes). */
export const OR_OPT_CHAIN_LENGTHS: readonly number[] = [1, 2, 3];

/** Distance lookup treating `null`/missing (unreachable) as +Infinity. */
export function d2(distances: DistanceMatrix, i: number, j: number): number {
  if (i === j) return 0;
  const v = distances[i]?.[j];
  return v == null ? Number.POSITIVE_INFINITY : v;
}

/** Closed-loop length of `order` (includes the closing leg back to order[0]). */
export function tourLength(distances: DistanceMatrix, order: number[]): number {
  let total = 0;
  for (let i = 0; i < order.length; i += 1) {
    const from = order[i]!;
    const to = order[(i + 1) % order.length]!;
    total += d2(distances, from, to);
  }
  return total;
}

/** Greedy nearest-neighbour seed, pinned at `startIndex`, deterministic ties. */
export function nearestNeighborSeed(
  distances: DistanceMatrix,
  startIndex: number,
): number[] {
  const n = distances.length;
  const visited = new Array<boolean>(n).fill(false);
  const order: number[] = [startIndex];
  visited[startIndex] = true;

  for (let step = 1; step < n; step += 1) {
    const last = order[order.length - 1]!;
    let bestNext = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (visited[j]) continue;
      const d = d2(distances, last, j);
      // Deterministic tie-break: lower index wins.
      if (d < bestDist - 1e-9 || (d <= bestDist + 1e-9 && j < bestNext)) {
        bestDist = d;
        bestNext = j;
      }
    }
    if (bestNext < 0) {
      bestNext = visited.indexOf(false);
    }
    visited[bestNext] = true;
    order.push(bestNext);
  }
  return order;
}

/** Return a copy of `order` with segment [i..k] reversed. */
export function reverseSegment(order: number[], i: number, k: number): number[] {
  const out = order.slice();
  let lo = i;
  let hi = k;
  while (lo < hi) {
    const tmp = out[lo]!;
    out[lo] = out[hi]!;
    out[hi] = tmp;
    lo += 1;
    hi -= 1;
  }
  return out;
}

/**
 * Apply one Or-opt move: remove `order[i..i+L-1]` and reinsert it before
 * position `j` (taken in the original-array index space).
 */
export function applyOrOptMove(
  order: readonly number[],
  i: number,
  L: number,
  j: number,
): number[] {
  const segment = order.slice(i, i + L);
  const rest = order.slice(0, i).concat(order.slice(i + L));
  const insertAt = j > i ? j - L : j;
  rest.splice(insertAt, 0, ...segment);
  return rest;
}
