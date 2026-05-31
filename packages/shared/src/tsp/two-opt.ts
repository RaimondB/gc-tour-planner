// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Closed-loop TSP solver: Nearest-Neighbor seed + 2-opt improvement.
 *
 * Pure, deterministic, side-effect-free — fixed input produces fixed output.
 * Cap the input set at ~50 nodes; beyond that, swap in `SolverTourPlanner`.
 *
 * Distance is supplied as a symmetric matrix `distances[i][j]`. Disconnected
 * pairs (no walking route) are represented as `null` — the solver treats them
 * as +Infinity so the tour avoids them when alternatives exist, and the caller
 * is expected to drop unreachable nodes upstream of this call.
 */
export type DistanceMatrix = readonly (readonly (number | null)[])[];

export interface TwoOptResult {
  /** Visit order as indices into the input distance matrix. Length = N. */
  order: number[];
  /** Closed-loop length: sum of leg distances plus the closing leg back to order[0]. */
  totalDistance: number;
}

export interface SolveTwoOptOptions {
  /**
   * Run an Or-opt local-search pass after 2-opt converges, then alternate
   * 2-opt ↔ Or-opt until neither finds further improvement (classical
   * Variable Neighborhood Descent — VND).
   *
   * Or-opt picks a chain of 1, 2, or 3 consecutive nodes and tries
   * inserting it at every other position; takes the best-improving move
   * per pass. Strictly orthogonal to 2-opt (which only reverses
   * segments) — they catch different topologies, so combining them
   * dominates either alone on real-world inputs with > ~10 nodes.
   *
   * Default `true`. Tiny extra work (≤ MAX_OR_OPT_ITERATIONS × O(N²))
   * and never produces a worse tour than plain 2-opt, so the planner
   * gets it for free. Opt out (e.g. for unit tests on synthetic data
   * where you want the exact 2-opt fixed point) by passing `false`.
   */
  orOpt?: boolean;
}

/** Maximum 2-opt iterations before bailing out. With N ≤ 50 we converge fast. */
const MAX_ITERATIONS = 1_000;

/** Maximum Or-opt iterations before bailing out. Independent budget — Or-opt's
 *  per-iter work is O(N²·3) vs 2-opt's O(N²), and they may chain (Or-opt
 *  finds a move → re-run 2-opt → new ground for Or-opt). */
const MAX_OR_OPT_ITERATIONS = 1_000;

/**
 * Hard cap on the outer VND rounds (alternating 2-opt ↔ Or-opt). Each round
 * only applies strict (> 1e-9) improvements so the loop is monotonic and
 * "converges", but its only natural bound is tourLength/epsilon — astronomically
 * large if the two neighborhoods oscillate on floating-point noise. That can
 * peg a core and block the Node event loop for the whole API. Real inputs
 * (N ≤ 50) settle in a handful of rounds, so 64 is comfortably generous while
 * guaranteeing termination. The returned order is still a valid tour. */
const MAX_VND_ROUNDS = 64;

/**
 * Solve the closed-loop TSP.
 *
 * @param distances Symmetric N×N distance matrix. Diagonal must be 0.
 * @param startIndex Index of the node that must appear first in the returned
 *   order (parking-anchored loops want the cluster centroid's nearest cache,
 *   etc.). Defaults to 0. The closing leg always returns to this node.
 */
export function solveTwoOpt(
  distances: DistanceMatrix,
  startIndex = 0,
  options: SolveTwoOptOptions = {},
): TwoOptResult {
  const { orOpt = true } = options;
  const n = distances.length;
  if (n === 0) return { order: [], totalDistance: 0 };
  if (n === 1) return { order: [0], totalDistance: 0 };
  if (startIndex < 0 || startIndex >= n) {
    throw new RangeError(
      `startIndex ${startIndex} out of range for matrix of size ${n}`,
    );
  }

  let order = nearestNeighborSeed(distances, startIndex);

  // VND: alternate 2-opt and Or-opt to convergence. The outer loop
  // terminates when a full pass of *both* finds no improvement; until
  // then, a hit in either re-arms the other neighborhood. When `orOpt`
  // is off (or `n < 4`, which makes Or-opt trivial) the outer loop
  // runs once and degenerates back to plain 2-opt.
  let vndImproved = true;
  let vndRounds = 0;
  while (vndImproved && vndRounds < MAX_VND_ROUNDS) {
    vndRounds += 1;
    vndImproved = false;
    const next2 = twoOptPass(distances, order, n);
    if (next2.improved) {
      order = next2.order;
      vndImproved = true;
    }
    if (orOpt && n >= 4) {
      const nextO = orOptPass(distances, order, n);
      if (nextO.improved) {
        order = nextO.order;
        vndImproved = true;
      }
    }
  }

  return { order, totalDistance: tourLength(distances, order) };
}

/**
 * One pass of 2-opt to convergence. Extracted so the VND loop can run it
 * multiple times after Or-opt re-arms the search.
 */
function twoOptPass(
  distances: DistanceMatrix,
  startOrder: number[],
  n: number,
): { order: number[]; improved: boolean } {
  let order = startOrder;
  let everImproved = false;
  let improved = true;
  let iterations = 0;
  while (improved && iterations < MAX_ITERATIONS) {
    improved = false;
    iterations += 1;
    // 2-opt: reverse every segment (i+1..k) and keep the swap that shortens
    // the closed loop the most this pass. i starts at 1 because position 0 is
    // pinned to startIndex.
    let bestDelta = 0;
    let bestI = -1;
    let bestK = -1;
    for (let i = 1; i < n - 1; i += 1) {
      for (let k = i + 1; k < n; k += 1) {
        const a = order[i - 1]!;
        const b = order[i]!;
        const c = order[k]!;
        // The leg that follows position k closes back to order[0] when k=n-1.
        const d = order[(k + 1) % n]!;
        const before = d2(distances, a, b) + d2(distances, c, d);
        const after = d2(distances, a, c) + d2(distances, b, d);
        const delta = after - before;
        if (delta < bestDelta - 1e-9) {
          bestDelta = delta;
          bestI = i;
          bestK = k;
        }
      }
    }
    if (bestI >= 0) {
      order = reverseSegment(order, bestI, bestK);
      improved = true;
      everImproved = true;
    }
  }
  return { order, improved: everImproved };
}

/**
 * Or-opt local search to convergence. Considers all moves that pluck a
 * chain of 1, 2, or 3 consecutive nodes out of the tour and reinsert it
 * at a different position; applies the best-improving move per pass.
 *
 * Strictly symmetric — we never reverse the chain on reinsertion. With
 * symmetric distance matrices the reversed orientation has the same net
 * delta (only entry/exit edges change, internal chain length is
 * invariant). If we ever route on asymmetric distances we'd need to
 * also test the reversed chain.
 *
 * Position 0 is pinned (the start node) — segments excluded from
 * starting there, insertions never placed before it.
 */
function orOptPass(
  distances: DistanceMatrix,
  startOrder: number[],
  n: number,
): { order: number[]; improved: boolean } {
  let order = startOrder;
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
      // Segment positions [i .. i+L-1]. Must not include position 0
      // (pinned) and must fit inside the tour.
      const iEnd = n - L;
      for (let i = 1; i <= iEnd; i += 1) {
        const segHead = order[i]!;
        const segTail = order[i + L - 1]!;
        const pred = order[i - 1]!;
        const succ = order[(i + L) % n]!;
        const segRemovedEdges = d2(distances, pred, segHead) + d2(distances, segTail, succ);
        const segReplaceEdge = d2(distances, pred, succ);
        // Try inserting segment before position j in [1, n].
        // j == i or j == i+L means "leave segment where it is".
        for (let j = 1; j <= n; j += 1) {
          if (j >= i && j <= i + L) continue;
          const beforeIdx = (j - 1 + n) % n;
          const afterIdx = j % n;
          const before = order[beforeIdx]!;
          const after = order[afterIdx]!;
          const insertRemovedEdge = d2(distances, before, after);
          const insertAddedEdges = d2(distances, before, segHead) + d2(distances, segTail, after);
          const delta =
            segReplaceEdge + insertAddedEdges - (segRemovedEdges + insertRemovedEdge);
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
      order = applyOrOptMove(order, bestI, bestL, bestJ);
      improved = true;
      everImproved = true;
    }
  }
  return { order, improved: everImproved };
}

const OR_OPT_CHAIN_LENGTHS: readonly number[] = [1, 2, 3];

/**
 * Apply one Or-opt move: remove `order[i..i+L-1]` and reinsert it
 * before position `j` (with `j` taken in the original-array index space).
 */
function applyOrOptMove(
  order: readonly number[],
  i: number,
  L: number,
  j: number,
): number[] {
  const segment = order.slice(i, i + L);
  const rest = order.slice(0, i).concat(order.slice(i + L));
  // After removing L items at position i, indices > i shift left by L.
  const insertAt = j > i ? j - L : j;
  rest.splice(insertAt, 0, ...segment);
  return rest;
}

function nearestNeighborSeed(
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
    // Every unvisited node is reachable from at least one other node by
    // construction (caller drops fully-disconnected nodes), so bestNext must
    // be a real index here. If somehow it isn't, fall back to the first
    // unvisited node so the tour still has N entries — the caller's matrix
    // guarantee was the real bug.
    if (bestNext < 0) {
      bestNext = visited.indexOf(false);
    }
    visited[bestNext] = true;
    order.push(bestNext);
  }
  return order;
}

function reverseSegment(order: number[], i: number, k: number): number[] {
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

function tourLength(distances: DistanceMatrix, order: number[]): number {
  let total = 0;
  for (let i = 0; i < order.length; i += 1) {
    const from = order[i]!;
    const to = order[(i + 1) % order.length]!;
    total += d2(distances, from, to);
  }
  return total;
}

function d2(distances: DistanceMatrix, i: number, j: number): number {
  if (i === j) return 0;
  const v = distances[i]?.[j];
  return v == null ? Number.POSITIVE_INFINITY : v;
}
