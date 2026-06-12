// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { UndirectedGraph } from "graphology";

/**
 * Hand-rolled Leiden community detection (Traag, Waltman & van Eck, 2019) on a
 * weighted undirected graph, modularity objective with resolution γ.
 *
 * Drop-in for the `graphology-communities-louvain` call: same `(graph, {
 * resolution, rng })` shape, same `Record<nodeId, communityId>` return, so it
 * slots into the existing resolution-sweep + Jaccard-dedup pipeline.
 *
 * Why Leiden over Louvain: Louvain can leave a community internally
 * disconnected, because it aggregates whole communities before re-checking
 * them. Leiden inserts a **refinement** phase — within each Louvain-style
 * community, nodes re-cluster into sub-communities by merging only *along
 * edges* — and then aggregates on the *refined* partition while seeding the
 * next level with the *unrefined* community labels. The result: every returned
 * community is connected (Louvain's headline defect, fixed).
 *
 * The three phases per level:
 *   1. **Local moving** (queue-based, like Louvain's fast local move).
 *   2. **Refinement** — singletons within each community merge along edges only
 *      when modularity improves, so sub-communities are connected by
 *      construction. (Faithful simplification: we use a greedy connectivity-
 *      preserving merge rather than the paper's stochastic θ-randomised,
 *      γ-separation-gated variant — the connectivity guarantee is preserved.)
 *   3. **Aggregation** by the refined partition; each aggregate node inherits
 *      the phase-1 community label as its starting assignment for the next
 *      level.
 *
 * Pure + deterministic: all randomness comes from the supplied seeded `rng`,
 * and every tie breaks on the lower index/label.
 */

const EPS = 1e-12;

interface Level {
  size: number;
  /** neighbour index → summed edge weight (no self-loops). */
  adj: Array<Array<[number, number]>>;
  /** weighted self-loop per node (intra-aggregate edge weight). */
  selfLoop: number[];
  /** weighted degree (incident edge weights + 2×self-loop). */
  k: number[];
  /** original node indices contained in each level node. */
  members: number[][];
}

export function leidenCommunities(
  g: UndirectedGraph,
  opts: { resolution: number; rng: () => number },
): Record<string, number> {
  const nodeList = g.nodes();
  const n = nodeList.length;
  const result: Record<string, number> = {};
  if (n === 0) return result;
  const indexOf = new Map<string, number>();
  nodeList.forEach((id, i) => indexOf.set(id, i));

  const adj: Array<Array<[number, number]>> = Array.from(
    { length: n },
    () => [],
  );
  const k = new Array<number>(n).fill(0);
  let totalW = 0;
  g.forEachEdge((_e, attr, s, t) => {
    const i = indexOf.get(s)!;
    const j = indexOf.get(t)!;
    if (i === j) return;
    const w = (attr.weight as number) ?? 1;
    adj[i]!.push([j, w]);
    adj[j]!.push([i, w]);
    k[i]! += w;
    k[j]! += w;
    totalW += w;
  });
  const m2 = 2 * totalW; // total weighted degree; modularity normaliser
  if (m2 <= 0) {
    // No edges — every node is its own community.
    nodeList.forEach((id, i) => (result[id] = i));
    return result;
  }

  const { resolution: gamma, rng } = opts;

  let level: Level = {
    size: n,
    adj,
    selfLoop: new Array<number>(n).fill(0),
    k,
    members: nodeList.map((_id, i) => [i]),
  };
  // Community label per current-level node.
  let comm = level.members.map((_m, i) => i);

  for (let pass = 0; pass < 64; pass += 1) {
    comm = localMove(level, comm, gamma, m2, rng);
    const refined = refine(level, comm, gamma, m2, rng);
    const refinedCount = countLabels(refined);
    if (refinedCount >= level.size) break; // nothing left to aggregate

    // Aggregate on the refined partition; carry the phase-1 label forward.
    const { next, labelOf } = aggregate(level, refined);
    const commNext = new Array<number>(next.size).fill(0);
    for (let i = 0; i < level.size; i += 1) {
      commNext[labelOf[i]!] = comm[i]!; // all members of a refined comm share comm
    }
    level = next;
    comm = normalize(commNext);
  }

  // Expand final-level community labels back onto the original nodes.
  for (let a = 0; a < level.size; a += 1) {
    const c = comm[a]!;
    for (const orig of level.members[a]!) result[nodeList[orig]!] = c;
  }
  return result;
}

/* --- phase 1: local moving --------------------------------------------- */

function localMove(
  level: Level,
  initial: readonly number[],
  gamma: number,
  m2: number,
  rng: () => number,
): number[] {
  const { size, adj, k } = level;
  const comm = initial.slice();
  const tot = new Map<number, number>();
  for (let i = 0; i < size; i += 1) {
    tot.set(comm[i]!, (tot.get(comm[i]!) ?? 0) + k[i]!);
  }
  let nextLabel = (comm.length ? Math.max(...comm) : -1) + 1;

  const queue = shuffledRange(size, rng);
  const inQueue = new Array<boolean>(size).fill(true);
  let head = 0;
  while (head < queue.length) {
    const v = queue[head]!;
    head += 1;
    inQueue[v] = false;

    // Edge weight from v to each neighbouring community.
    const wTo = new Map<number, number>();
    for (const [u, w] of adj[v]!) {
      const cu = comm[u]!;
      wTo.set(cu, (wTo.get(cu) ?? 0) + w);
    }
    const cv = comm[v]!;
    tot.set(cv, (tot.get(cv) ?? 0) - k[v]!); // remove v from its community

    // Best target: own community, a neighbour community, or a fresh singleton.
    let bestC = cv;
    let bestGain =
      (wTo.get(cv) ?? 0) - (gamma * k[v]! * (tot.get(cv) ?? 0)) / m2;
    for (const c of [...wTo.keys()].sort((a, b) => a - b)) {
      const gain = wTo.get(c)! - (gamma * k[v]! * (tot.get(c) ?? 0)) / m2;
      if (
        gain > bestGain + EPS ||
        (Math.abs(gain - bestGain) < EPS && c < bestC)
      ) {
        bestGain = gain;
        bestC = c;
      }
    }
    if (bestGain < -EPS) bestC = nextLabel++; // isolate: gain 0 beats all moves

    comm[v] = bestC;
    tot.set(bestC, (tot.get(bestC) ?? 0) + k[v]!);
    if (bestC !== cv) {
      for (const [u] of adj[v]!) {
        if (comm[u] !== bestC && !inQueue[u]) {
          inQueue[u] = true;
          queue.push(u);
        }
      }
    }
  }
  return normalize(comm);
}

/* --- phase 2: refinement ------------------------------------------------ */

function refine(
  level: Level,
  comm: readonly number[],
  gamma: number,
  m2: number,
  rng: () => number,
): number[] {
  const { size, adj, k } = level;
  const refined = Array.from({ length: size }, (_v, i) => i); // singletons
  const totR = new Map<number, number>();
  for (let i = 0; i < size; i += 1) totR.set(i, k[i]!);

  // Group nodes by phase-1 community (deterministic order by community id).
  const byComm = new Map<number, number[]>();
  for (let i = 0; i < size; i += 1) {
    const c = comm[i]!;
    const list = byComm.get(c);
    if (list) list.push(i);
    else byComm.set(c, [i]);
  }

  for (const c of [...byComm.keys()].sort((a, b) => a - b)) {
    const members = byComm.get(c)!;
    const order = shuffle(members.slice(), rng);
    for (const v of order) {
      if (refined[v] !== v) continue; // only still-singleton nodes initiate a merge

      // Candidate refined sub-communities reachable from v WITHIN community c.
      const wTo = new Map<number, number>();
      for (const [u, w] of adj[v]!) {
        if (comm[u] !== c) continue; // stay inside the phase-1 community
        wTo.set(refined[u]!, (wTo.get(refined[u]!) ?? 0) + w);
      }
      totR.set(v, (totR.get(v) ?? 0) - k[v]!); // pull v out (it's a singleton)

      let bestT = v; // stay singleton ⇒ gain 0
      let bestGain = 0;
      for (const t of [...wTo.keys()].sort((a, b) => a - b)) {
        if (t === v) continue;
        const gain = wTo.get(t)! - (gamma * k[v]! * (totR.get(t) ?? 0)) / m2;
        if (
          gain > bestGain + EPS ||
          (Math.abs(gain - bestGain) < EPS && t < bestT)
        ) {
          bestGain = gain;
          bestT = t;
        }
      }
      refined[v] = bestT;
      totR.set(bestT, (totR.get(bestT) ?? 0) + k[v]!);
    }
  }
  return refined;
}

/* --- phase 3: aggregation ---------------------------------------------- */

function aggregate(
  level: Level,
  refined: readonly number[],
): { next: Level; labelOf: number[] } {
  // Relabel refined communities to 0..R-1, ordered by smallest member index.
  const labelOf = normalize(refined);
  const R = countLabels(labelOf);

  const members: number[][] = Array.from({ length: R }, () => []);
  const selfLoop = new Array<number>(R).fill(0);
  const k = new Array<number>(R).fill(0);
  for (let i = 0; i < level.size; i += 1) {
    const r = labelOf[i]!;
    for (const o of level.members[i]!) members[r]!.push(o);
    selfLoop[r]! += level.selfLoop[i]!;
    k[r]! += level.k[i]!;
  }

  // Sum inter-community edge weights; intra-community edges become self-loops.
  const edgeAcc = new Map<number, Map<number, number>>();
  for (let i = 0; i < level.size; i += 1) {
    const ri = labelOf[i]!;
    for (const [j, w] of level.adj[i]!) {
      if (j < i) continue; // each undirected edge once
      const rj = labelOf[j]!;
      if (ri === rj) {
        selfLoop[ri]! += w;
      } else {
        addEdge(edgeAcc, ri, rj, w);
      }
    }
  }
  const adj: Array<Array<[number, number]>> = Array.from(
    { length: R },
    () => [],
  );
  for (const [a, row] of edgeAcc) {
    for (const [b, w] of row) {
      if (a < b) {
        adj[a]!.push([b, w]);
        adj[b]!.push([a, w]);
      }
    }
  }

  return { next: { size: R, adj, selfLoop, k, members }, labelOf };
}

/* --- helpers ------------------------------------------------------------ */

function addEdge(
  acc: Map<number, Map<number, number>>,
  a: number,
  b: number,
  w: number,
): void {
  let row = acc.get(a);
  if (!row) {
    row = new Map();
    acc.set(a, row);
  }
  row.set(b, (row.get(b) ?? 0) + w);
  let rowB = acc.get(b);
  if (!rowB) {
    rowB = new Map();
    acc.set(b, rowB);
  }
  rowB.set(a, (rowB.get(a) ?? 0) + w);
}

/** Relabel to dense 0..K-1 ids assigned in order of first appearance. */
function normalize(labels: readonly number[]): number[] {
  const map = new Map<number, number>();
  const out = new Array<number>(labels.length);
  let next = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const l = labels[i]!;
    let m = map.get(l);
    if (m === undefined) {
      m = next++;
      map.set(l, m);
    }
    out[i] = m;
  }
  return out;
}

function countLabels(labels: readonly number[]): number {
  return new Set(labels).size;
}

/** Fisher–Yates over [0..n) using the seeded rng. */
function shuffledRange(n: number, rng: () => number): number[] {
  const arr = Array.from({ length: n }, (_v, i) => i);
  return shuffle(arr, rng);
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
