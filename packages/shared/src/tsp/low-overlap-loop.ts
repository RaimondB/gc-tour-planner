// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Low-overlap closed-loop solver — the second, opt-in loop algorithm that runs
 * side by side with `solveTwoOpt` (./two-opt.ts, the default shortest-distance
 * solver, left untouched). Selected per plan via the `loopObjective` field.
 *
 * Same Nearest-Neighbor → 2-opt → Or-opt (VND) skeleton, but each move is
 * scored against `Σ dist + β · retrace` instead of pure distance, where
 * `retrace` is the straight-line overlap proxy from ./leg-overlap.ts. This
 * shapes the *cache order* to avoid walking the same street twice, rather than
 * patching geometry after the order is frozen (the existing loop-aware leg
 * picker still does that, untouched).
 *
 * Pure, deterministic, side-effect-free — fixed input produces fixed output.
 * The strict `delta < -1e-9` improvement gate, lower-index tie-breaks, and the
 * `MAX_VND_ROUNDS` bound are preserved so the search stays monotone and
 * terminating (NFR-4). `totalDistance` is pure distance (callers' marginal-trim
 * math depends on that); `retraceMeters` is reported separately for diagnostics.
 */

import { buildLegCellMap, OverlapAccumulator } from "./leg-overlap.js";
import {
  applyOrOptMove,
  d2,
  MAX_ITERATIONS,
  MAX_OR_OPT_ITERATIONS,
  MAX_VND_ROUNDS,
  nearestNeighborSeed,
  OR_OPT_CHAIN_LENGTHS,
  reverseSegment,
  tourLength,
} from "./loop-common.js";
import type { DistanceMatrix } from "./two-opt.js";

export interface LowOverlapResult {
  /** Visit order as indices into the input distance matrix. Length = N. */
  order: number[];
  /** Closed-loop length (pure distance, same semantics as TwoOptResult). */
  totalDistance: number;
  /** Retrace penalty of the final loop, in meters (diagnostic only). */
  retraceMeters: number;
}

export interface SolveLowOverlapOptions {
  /** Weight on retrace in the objective: `dist + β · retrace`. */
  beta: number;
  /** Grid cell size (m) for the straight-line overlap proxy. */
  gridMeters: number;
  /** Run Or-opt after 2-opt (VND). Default true; matches solveTwoOpt. */
  orOpt?: boolean;
}

/**
 * Solve the closed-loop TSP minimising `Σ dist + β · retrace`.
 *
 * @param distances Symmetric N×N distance matrix (meters); diagonal 0; `null`
 *   for unreachable pairs (caller drops fully-disconnected nodes upstream).
 * @param startIndex Pinned first node (parking-anchored seed). Defaults to 0.
 * @param coords `[lng, lat]` per matrix index — feeds the overlap proxy.
 * @param options β weight + proxy grid size.
 */
export function solveLowOverlapLoop(
  distances: DistanceMatrix,
  startIndex: number,
  coords: readonly (readonly [number, number])[],
  options: SolveLowOverlapOptions,
): LowOverlapResult {
  const { beta, gridMeters, orOpt = true } = options;
  const n = distances.length;
  if (n === 0) return { order: [], totalDistance: 0, retraceMeters: 0 };
  if (n === 1) return { order: [0], totalDistance: 0, retraceMeters: 0 };
  if (startIndex < 0 || startIndex >= n) {
    throw new RangeError(
      `startIndex ${startIndex} out of range for matrix of size ${n}`,
    );
  }

  const map = buildLegCellMap(coords, gridMeters);
  const order = nearestNeighborSeed(distances, startIndex);

  // Live overlap state for the closed loop (all n edges, incl. the closing one).
  const acc = new OverlapAccumulator(map);
  for (let i = 0; i < n; i += 1) {
    acc.add(order[i]!, order[(i + 1) % n]!);
  }

  let vndImproved = true;
  let vndRounds = 0;
  while (vndImproved && vndRounds < MAX_VND_ROUNDS) {
    vndRounds += 1;
    vndImproved = false;
    if (twoOptPass(distances, order, n, acc, beta)) vndImproved = true;
    if (orOpt && n >= 4 && orOptPass(distances, order, n, acc, beta)) {
      vndImproved = true;
    }
  }

  return {
    order,
    totalDistance: tourLength(distances, order),
    retraceMeters: acc.penalty(),
  };
}

/**
 * 2-opt to convergence, scoring on distance + β·retrace. Mutates `order` in
 * place via reassignment is not possible (it's a local), so we operate on the
 * passed array reference by copying the best result back. Keeps `acc` in sync
 * with each applied move.
 *
 * Returns true if any improving move was applied.
 */
function twoOptPass(
  distances: DistanceMatrix,
  order: number[],
  n: number,
  acc: OverlapAccumulator,
  beta: number,
): boolean {
  let everImproved = false;
  let improved = true;
  let iterations = 0;
  while (improved && iterations < MAX_ITERATIONS) {
    improved = false;
    iterations += 1;
    let bestDelta = 0;
    let bestI = -1;
    let bestK = -1;
    for (let i = 1; i < n - 1; i += 1) {
      for (let k = i + 1; k < n; k += 1) {
        const a = order[i - 1]!;
        const b = order[i]!;
        const c = order[k]!;
        const d = order[(k + 1) % n]!;
        const distDelta =
          d2(distances, a, c) +
          d2(distances, b, d) -
          (d2(distances, a, b) + d2(distances, c, d));
        const retraceDelta =
          beta === 0
            ? 0
            : beta *
              acc.previewDelta(
                [
                  [a, b],
                  [c, d],
                ],
                [
                  [a, c],
                  [b, d],
                ],
              );
        const delta = distDelta + retraceDelta;
        if (delta < bestDelta - 1e-9) {
          bestDelta = delta;
          bestI = i;
          bestK = k;
        }
      }
    }
    if (bestI >= 0) {
      const a = order[bestI - 1]!;
      const b = order[bestI]!;
      const c = order[bestK]!;
      const d = order[(bestK + 1) % n]!;
      acc.remove(a, b);
      acc.remove(c, d);
      acc.add(a, c);
      acc.add(b, d);
      const next = reverseSegment(order, bestI, bestK);
      for (let i = 0; i < n; i += 1) order[i] = next[i]!;
      improved = true;
      everImproved = true;
    }
  }
  return everImproved;
}

/**
 * Or-opt to convergence, scoring on distance + β·retrace. Same move set as the
 * shortest solver (move chains of 1–3 nodes), with the retrace delta of the
 * three swapped edges added to the score. Keeps `acc` in sync.
 */
function orOptPass(
  distances: DistanceMatrix,
  order: number[],
  n: number,
  acc: OverlapAccumulator,
  beta: number,
): boolean {
  let everImproved = false;
  let improved = true;
  let iterations = 0;
  while (improved && iterations < MAX_OR_OPT_ITERATIONS) {
    improved = false;
    iterations += 1;
    let bestDelta = 0;
    let bestI = -1;
    let bestL = 0;
    let bestJ = -1;
    for (const L of OR_OPT_CHAIN_LENGTHS) {
      const iEnd = n - L;
      for (let i = 1; i <= iEnd; i += 1) {
        const segHead = order[i]!;
        const segTail = order[i + L - 1]!;
        const pred = order[i - 1]!;
        const succ = order[(i + L) % n]!;
        for (let j = 1; j <= n; j += 1) {
          if (j >= i && j <= i + L) continue;
          const before = order[(j - 1 + n) % n]!;
          const after = order[j % n]!;
          const distDelta =
            d2(distances, pred, succ) +
            d2(distances, before, segHead) +
            d2(distances, segTail, after) -
            (d2(distances, pred, segHead) +
              d2(distances, segTail, succ) +
              d2(distances, before, after));
          const retraceDelta =
            beta === 0
              ? 0
              : beta *
                acc.previewDelta(
                  [
                    [pred, segHead],
                    [segTail, succ],
                    [before, after],
                  ],
                  [
                    [pred, succ],
                    [before, segHead],
                    [segTail, after],
                  ],
                );
          const delta = distDelta + retraceDelta;
          if (delta < bestDelta - 1e-9) {
            bestDelta = delta;
            bestI = i;
            bestL = L;
            bestJ = j;
          }
        }
      }
    }
    if (bestI >= 0) {
      const segHead = order[bestI]!;
      const segTail = order[bestI + bestL - 1]!;
      const pred = order[bestI - 1]!;
      const succ = order[(bestI + bestL) % n]!;
      const before = order[(bestJ - 1 + n) % n]!;
      const after = order[bestJ % n]!;
      acc.remove(pred, segHead);
      acc.remove(segTail, succ);
      acc.remove(before, after);
      acc.add(pred, succ);
      acc.add(before, segHead);
      acc.add(segTail, after);
      const next = applyOrOptMove(order, bestI, bestL, bestJ);
      for (let i = 0; i < n; i += 1) order[i] = next[i]!;
      improved = true;
      everImproved = true;
    }
  }
  return everImproved;
}
