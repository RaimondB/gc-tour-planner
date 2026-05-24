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

/** Maximum 2-opt iterations before bailing out. With N ≤ 50 we converge fast. */
const MAX_ITERATIONS = 1_000;

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
): TwoOptResult {
  const n = distances.length;
  if (n === 0) return { order: [], totalDistance: 0 };
  if (n === 1) return { order: [0], totalDistance: 0 };
  if (startIndex < 0 || startIndex >= n) {
    throw new RangeError(
      `startIndex ${startIndex} out of range for matrix of size ${n}`,
    );
  }

  let order = nearestNeighborSeed(distances, startIndex);

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
    }
  }

  return { order, totalDistance: tourLength(distances, order) };
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
