// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Collapse caches that sit so close together (by walking distance) that
 * visiting them as separate stops wouldn't change the route — most importantly
 * the co-located stages of an Adventure Lab. Each group becomes one routing
 * node, so Pass-2 (TSP, trim, parking, per-leg OSRM) runs on far fewer nodes
 * (the 20+-cache slowdown) and near-zero legs stop producing weird orderings.
 * The route stays distance-optimal: members are within `thresholdMeters`, so
 * which one represents the group barely moves anything, and adventures whose
 * stages are spread out stay separate nodes and interleave normally.
 *
 * Pure + dependency-free for unit-testing. The caller expands groups back to
 * their members on output, so `members` preserves every id.
 */
export interface ColocatedGroups {
  /** One representative cache id per group (the routing node). */
  repIds: number[];
  /** Walking-distance matrix between representatives, indexed like `repIds`. */
  repDistances: (number | null)[][];
  /** repId → its member ids (incl. the rep), ordered for visiting. */
  members: Map<number, number[]>;
}

/**
 * @param ids            connected cache ids (post `filterConnected`)
 * @param distances      walking-metre matrix indexed like `ids` (null = unreachable)
 * @param orderKey       within-group visit ordering (e.g. AL stage_sequence; lower first)
 * @param thresholdMeters max walking distance to treat two caches as one stop (0 disables)
 */
export function collapseColocated(
  ids: readonly number[],
  distances: readonly (readonly (number | null)[])[],
  orderKey: (id: number) => number,
  thresholdMeters: number,
): ColocatedGroups {
  const n = ids.length;

  // Union-find over indices: union i,j when they're mutually close enough that
  // routing through both ≈ routing through one.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const nx = parent[x]!;
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  if (thresholdMeters > 0) {
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dij = distances[i]?.[j];
        const dji = distances[j]?.[i];
        // Use the smaller of the two directions; both must be known.
        const d = dij == null ? dji : dji == null ? dij : Math.min(dij, dji);
        if (d != null && d <= thresholdMeters) union(i, j);
      }
    }
  }

  // Gather members per root, in first-seen order of roots.
  const rootToMembers = new Map<number, number[]>();
  const rootOrder: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    let arr = rootToMembers.get(r);
    if (!arr) {
      arr = [];
      rootToMembers.set(r, arr);
      rootOrder.push(r);
    }
    arr.push(i);
  }

  // For each group pick a representative: the member that sorts first by
  // (orderKey, id) — for an Adventure Lab that's stage 1, so within-group
  // visiting reads 1→N.
  const sortMembers = (idxs: number[]): number[] =>
    idxs.slice().sort((a, b) => {
      const ka = orderKey(ids[a]!);
      const kb = orderKey(ids[b]!);
      if (ka !== kb) return ka - kb;
      return ids[a]! - ids[b]!;
    });

  const repIdxByRoot = new Map<number, number>();
  const members = new Map<number, number[]>();
  const repIds: number[] = [];
  for (const root of rootOrder) {
    const sorted = sortMembers(rootToMembers.get(root)!);
    const repIdx = sorted[0]!;
    repIdxByRoot.set(root, repIdx);
    repIds.push(ids[repIdx]!);
    members.set(
      ids[repIdx]!,
      sorted.map((i) => ids[i]!),
    );
  }

  // Reduced matrix: distance between two groups = distance between their reps.
  const repIdxs = rootOrder.map((root) => repIdxByRoot.get(root)!);
  const repDistances: (number | null)[][] = repIdxs.map((ri) =>
    repIdxs.map((rj) => (ri === rj ? 0 : (distances[ri]?.[rj] ?? null))),
  );

  return { repIds, repDistances, members };
}
