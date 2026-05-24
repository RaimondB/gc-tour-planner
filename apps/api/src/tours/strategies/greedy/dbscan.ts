// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { distanceMeters, type ProjectedPoint } from "./equirectangular.js";

/**
 * Density-Based Spatial Clustering of Applications with Noise.
 *
 * Pure, hand-rolled, deterministic: points are processed in input order and
 * neighbor lists preserve discovery order, so the same input always produces
 * the same clusters.
 *
 * Inputs are pre-projected to local equirectangular meters (see
 * `equirectangular.ts`) so the distance check is plain Euclid.
 */
export function dbscan(
  points: readonly ProjectedPoint[],
  epsilon: number,
  minPts: number,
): { clusters: number[][]; noise: number[] } {
  const n = points.length;
  const visited = new Array<boolean>(n).fill(false);
  const assigned = new Array<boolean>(n).fill(false);
  const clusters: number[][] = [];
  const noise: number[] = [];

  for (let p = 0; p < n; p += 1) {
    if (visited[p]) continue;
    visited[p] = true;

    const neighbors = regionQuery(points, p, epsilon);
    if (neighbors.length < minPts) {
      noise.push(p);
      continue;
    }

    const cluster: number[] = [];
    expandCluster(
      points,
      p,
      neighbors,
      cluster,
      visited,
      assigned,
      epsilon,
      minPts,
    );
    clusters.push(cluster);
  }

  // Some noise points may have been picked up by a later cluster's neighbor
  // expansion — filter them out so noise is final.
  return { clusters, noise: noise.filter((i) => !assigned[i]) };
}

function expandCluster(
  points: readonly ProjectedPoint[],
  seed: number,
  seedNeighbors: number[],
  cluster: number[],
  visited: boolean[],
  assigned: boolean[],
  epsilon: number,
  minPts: number,
): void {
  cluster.push(seed);
  assigned[seed] = true;

  // Use array-as-queue; append new neighbors as we discover them.
  const queue = seedNeighbors.slice();
  let i = 0;
  while (i < queue.length) {
    const q = queue[i]!;
    i += 1;
    if (!visited[q]) {
      visited[q] = true;
      const qNeighbors = regionQuery(points, q, epsilon);
      if (qNeighbors.length >= minPts) {
        for (const qn of qNeighbors) {
          if (!queue.includes(qn)) queue.push(qn);
        }
      }
    }
    if (!assigned[q]) {
      cluster.push(q);
      assigned[q] = true;
    }
  }
}

function regionQuery(
  points: readonly ProjectedPoint[],
  origin: number,
  epsilon: number,
): number[] {
  // Textbook DBSCAN: the origin counts toward its own ε-neighborhood, so a
  // point with `minPts - 1` other points within ε qualifies as a core point.
  const out: number[] = [];
  const o = points[origin]!;
  for (let j = 0; j < points.length; j += 1) {
    if (distanceMeters(o, points[j]!) <= epsilon) out.push(j);
  }
  return out;
}

/**
 * DBSCAN variant that takes an arbitrary distance function instead of
 * pre-projected points. Caller supplies `n` (number of items) and
 * `distanceMeters(i, j)` returning meters (use `Number.POSITIVE_INFINITY`
 * for disconnected pairs — they will never cluster).
 *
 * This is the routability-aware path: the planner pre-computes an OSRM
 * walking matrix and passes a closure that reads from it, so caches separated
 * by a river or motorway end up unreachable rather than spuriously close.
 */
export function dbscanFromDistances(
  n: number,
  distanceMeters: (i: number, j: number) => number,
  epsilon: number,
  minPts: number,
): { clusters: number[][]; noise: number[] } {
  const visited = new Array<boolean>(n).fill(false);
  const assigned = new Array<boolean>(n).fill(false);
  const clusters: number[][] = [];
  const noise: number[] = [];

  const regionQueryByDistance = (origin: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j += 1) {
      if (distanceMeters(origin, j) <= epsilon) out.push(j);
    }
    return out;
  };

  for (let p = 0; p < n; p += 1) {
    if (visited[p]) continue;
    visited[p] = true;

    const neighbors = regionQueryByDistance(p);
    if (neighbors.length < minPts) {
      noise.push(p);
      continue;
    }

    const cluster: number[] = [];
    cluster.push(p);
    assigned[p] = true;

    const queue = neighbors.slice();
    let i = 0;
    while (i < queue.length) {
      const q = queue[i]!;
      i += 1;
      if (!visited[q]) {
        visited[q] = true;
        const qNeighbors = regionQueryByDistance(q);
        if (qNeighbors.length >= minPts) {
          for (const qn of qNeighbors) {
            if (!queue.includes(qn)) queue.push(qn);
          }
        }
      }
      if (!assigned[q]) {
        cluster.push(q);
        assigned[q] = true;
      }
    }
    clusters.push(cluster);
  }

  return { clusters, noise: noise.filter((i) => !assigned[i]) };
}
