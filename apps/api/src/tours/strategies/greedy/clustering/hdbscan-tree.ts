// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { MreachEdge } from "./hdbscan.js";

/**
 * True HDBSCAN* flat-cluster extraction over a mutual-reachability graph.
 *
 * This is the piece the legacy `hdbscan` strategy skips. Given the
 * mutual-reachability edges (already computed by `buildMreachEdges`), it:
 *
 *   1. Builds the **single-linkage hierarchy** (Kruskal MST → ordered merges).
 *   2. **Condenses** the dendrogram with `minClusterSize`, distinguishing a
 *      true split (both children ≥ minClusterSize) from points "falling out"
 *      of a persisting cluster.
 *   3. Computes per-cluster **stability** S(C) = Σ (λ_leave − λ_birth) with
 *      λ = 1 / mutual-reachability-distance.
 *   4. Selects a flat clustering by **Excess of Mass** (EoM): keep a cluster
 *      when its own stability is at least the summed stability of its selected
 *      descendants, otherwise keep the descendants.
 *
 * The walking graph is sparse and capped, so this runs over a *forest*, not a
 * single tree. Each connected component gets its own selectable root cluster
 * (HDBSCAN's `allow_single_cluster` semantics at the component level): a
 * uniformly dense pod with no real sub-structure surfaces as one cluster
 * instead of being dissolved into noise. Isolated caches (no finite mreach
 * edge) never enter the hierarchy and are dropped as noise (label −1).
 *
 * Pure module — type-only imports, no NestJS, no I/O — so it runs inside the
 * worker-thread planner pipeline (ADR-0014).
 *
 * Determinism (the codebase tie-breaks everything by cache id): merges are
 * ordered by (weight, min-endpoint, max-endpoint); dendrogram children are
 * stored smaller-min-id first; components are processed in ascending
 * min-id order; EoM favours the coarser parent on an exact stability tie;
 * emitted clusters and their members are sorted by cache id.
 */

/**
 * Distance floor (metres). Mutual-reachability distances are positive in
 * practice (the walking graph rejects suspicious zero-length legs), but a
 * genuinely co-located multi-stage pair can be ~0. Flooring keeps λ = 1/d
 * large-but-finite so stability sums never become NaN/∞.
 */
const DISTANCE_FLOOR = 1e-9;

export type HdbscanSelection = "eom" | "leaf";

/**
 * Extract flat HDBSCAN* clusters. Returns one cache-id array per selected
 * cluster (sorted ascending; clusters ordered by smallest member id). Points
 * not assigned to any selected cluster are noise and simply absent.
 */
export function extractHdbscanClusters(
  ids: readonly number[],
  mreachEdges: readonly MreachEdge[],
  minClusterSize: number,
  options?: { selection?: HdbscanSelection },
): number[][] {
  const n = ids.length;
  if (n < 2) return [];
  const selection = options?.selection ?? "eom";

  const dendro = buildSingleLinkage(ids, mreachEdges);
  const condensed = condenseTree(dendro, minClusterSize);
  if (condensed.clusters.length === 0) return [];

  const stability = computeStabilities(condensed);
  const selected =
    selection === "leaf"
      ? selectLeaves(condensed)
      : selectEoM(condensed, stability);

  return membersOf(dendro, condensed, selected);
}

/* --- 1. single-linkage hierarchy --------------------------------------- */

/**
 * Binary single-linkage dendrogram over the mreach edges.
 *
 * Leaves are the point indices `0..n-1` (cache `ids[i]`). Internal nodes are
 * `n..n+merges-1`; `childLeft/childRight` reference child node ids and
 * `mergeDist` is the mreach distance at which the node's two children fused
 * (equivalently, the distance at which the node splits as λ rises).
 *
 * Disconnected components leave separate roots — `roots` lists them in
 * ascending min-member-id order for deterministic downstream labelling.
 */
interface Dendrogram {
  /** Number of points (leaves). */
  n: number;
  /** Total nodes (leaves + internal). */
  total: number;
  childLeft: number[];
  childRight: number[];
  size: number[];
  /** Merge distance for internal nodes; 0 for leaves. */
  mergeDist: number[];
  /** Smallest cache id within the subtree. */
  minId: number[];
  /** Cache id for leaves; -1 for internal nodes. */
  cacheId: number[];
  /** Root node id per connected component, ascending min-member-id. */
  roots: number[];
}

function buildSingleLinkage(
  ids: readonly number[],
  mreachEdges: readonly MreachEdge[],
): Dendrogram {
  const n = ids.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < n; i += 1) indexOf.set(ids[i]!, i);

  // Ascending weight, tie-break (min endpoint, max endpoint) for determinism.
  const sorted = mreachEdges.slice().sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight;
    const aMin = Math.min(a.from, a.to);
    const bMin = Math.min(b.from, b.to);
    if (aMin !== bMin) return aMin - bMin;
    return Math.max(a.from, a.to) - Math.max(b.from, b.to);
  });

  // Node arrays — leaves first, internal nodes appended on merge.
  const childLeft: number[] = new Array(n).fill(-1);
  const childRight: number[] = new Array(n).fill(-1);
  const size: number[] = new Array(n).fill(1);
  const mergeDist: number[] = new Array(n).fill(0);
  const minId: number[] = ids.slice();
  const cacheId: number[] = ids.slice();
  let nextNode = n;

  // Union-find over point indices, tracking the current node id per component.
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const rootNode = new Array<number>(n);
  for (let i = 0; i < n; i += 1) rootNode[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };

  for (const e of sorted) {
    const ia = indexOf.get(e.from);
    const ib = indexOf.get(e.to);
    if (ia === undefined || ib === undefined) continue;
    const ra = find(ia);
    const rb = find(ib);
    if (ra === rb) continue;
    let na = rootNode[ra]!;
    let nb = rootNode[rb]!;
    // Canonical child order: smaller subtree-min on the left.
    if (minId[nb]! < minId[na]!) {
      const tmp = na;
      na = nb;
      nb = tmp;
    }
    const id = nextNode;
    nextNode += 1;
    childLeft[id] = na;
    childRight[id] = nb;
    size[id] = size[na]! + size[nb]!;
    mergeDist[id] = e.weight;
    minId[id] = Math.min(minId[na]!, minId[nb]!);
    cacheId[id] = -1;
    // Union; the larger subtree keeps the representative for shallow chains.
    if (size[ra] !== undefined && size[na]! >= size[nb]!) {
      parent[rb] = ra;
      rootNode[ra] = id;
    } else {
      parent[ra] = rb;
      rootNode[rb] = id;
    }
  }

  // Collect distinct component roots, ordered by smallest member id.
  const seen = new Set<number>();
  const roots: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = rootNode[find(i)]!;
    if (seen.has(r)) continue;
    seen.add(r);
    roots.push(r);
  }
  roots.sort((a, b) => minId[a]! - minId[b]!);

  return {
    n,
    total: nextNode,
    childLeft,
    childRight,
    size,
    mergeDist,
    minId,
    cacheId,
    roots,
  };
}

/* --- 2. condensed tree -------------------------------------------------- */

/**
 * Condensed tree as a flat edge list plus per-cluster metadata. `child` is a
 * point index (`< n`) for a fall-out point, or a cluster id (`>= clusterBase`)
 * for a sub-cluster. Cluster ids are disjoint from both point indices and
 * dendrogram node ids.
 */
interface CondensedTree {
  clusterBase: number;
  clusters: number[];
  /** All condensed edges (parent cluster → point or sub-cluster). */
  edges: Array<{
    parent: number;
    child: number;
    lambda: number;
    childSize: number;
  }>;
  /** λ at which each cluster is born (component roots = 0). */
  birth: Map<number, number>;
  /** Parent cluster of each cluster (component roots absent). */
  parentCluster: Map<number, number>;
  /** Sub-cluster children of each cluster. */
  childClusters: Map<number, number[]>;
  /** The dendrogram root node that seeded each component's root cluster. */
  rootDendroNode: Map<number, number>;
}

function lambdaOf(distance: number): number {
  return 1 / Math.max(distance, DISTANCE_FLOOR);
}

function condenseTree(
  dendro: Dendrogram,
  minClusterSize: number,
): CondensedTree {
  const { childLeft, childRight, size, mergeDist } = dendro;
  const clusterBase = dendro.total + 1;
  let nextCluster = clusterBase;
  const clusters: number[] = [];
  const edges: CondensedTree["edges"] = [];
  const birth = new Map<number, number>();
  const parentCluster = new Map<number, number>();
  const childClusters = new Map<number, number[]>();
  const rootDendroNode = new Map<number, number>();

  const isLeaf = (node: number): boolean => childLeft[node] === -1;
  const leavesUnder = (node: number): number[] => {
    const out: number[] = [];
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (isLeaf(cur)) {
        out.push(cur);
        continue;
      }
      stack.push(childLeft[cur]!, childRight[cur]!);
    }
    return out;
  };

  const addChildCluster = (par: number, child: number): void => {
    const list = childClusters.get(par);
    if (list) list.push(child);
    else childClusters.set(par, [child]);
  };

  for (const root of dendro.roots) {
    if (size[root]! < minClusterSize) continue; // whole component is noise
    const rootCluster = nextCluster;
    nextCluster += 1;
    clusters.push(rootCluster);
    birth.set(rootCluster, 0);
    rootDendroNode.set(rootCluster, root);

    // Top-down BFS so a node's cluster label is assigned before we process it.
    const relabel = new Map<number, number>();
    relabel.set(root, rootCluster);
    const ignore = new Set<number>();
    const queue: number[] = [root];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const node = queue[qi]!;
      if (ignore.has(node) || isLeaf(node)) continue;
      const left = childLeft[node]!;
      const right = childRight[node]!;
      const lambda = lambdaOf(mergeDist[node]!);
      const lc = size[left]!;
      const rc = size[right]!;
      const cluster = relabel.get(node)!;

      if (lc >= minClusterSize && rc >= minClusterSize) {
        // True split — both sides become new sub-clusters.
        for (const [childNode, childCount] of [
          [left, lc],
          [right, rc],
        ] as const) {
          const sub = nextCluster;
          nextCluster += 1;
          clusters.push(sub);
          relabel.set(childNode, sub);
          birth.set(sub, lambda);
          parentCluster.set(sub, cluster);
          addChildCluster(cluster, sub);
          rootDendroNode.set(sub, childNode);
          edges.push({
            parent: cluster,
            child: sub,
            lambda,
            childSize: childCount,
          });
          queue.push(childNode);
        }
      } else if (lc < minClusterSize && rc < minClusterSize) {
        // Both sides too small — every point falls out here.
        for (const leaf of leavesUnder(node)) {
          edges.push({ parent: cluster, child: leaf, lambda, childSize: 1 });
        }
        // Nothing below stays in a cluster.
        const stack = [left, right];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          ignore.add(cur);
          if (!isLeaf(cur)) stack.push(childLeft[cur]!, childRight[cur]!);
        }
      } else {
        // One side persists as the same cluster; the small side falls out.
        const big = lc >= minClusterSize ? left : right;
        const small = big === left ? right : left;
        relabel.set(big, cluster);
        queue.push(big);
        for (const leaf of leavesUnder(small)) {
          edges.push({ parent: cluster, child: leaf, lambda, childSize: 1 });
        }
        const stack = [small];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          ignore.add(cur);
          if (!isLeaf(cur)) stack.push(childLeft[cur]!, childRight[cur]!);
        }
      }
    }
  }

  return {
    clusterBase,
    clusters,
    edges,
    birth,
    parentCluster,
    childClusters,
    rootDendroNode,
  };
}

/* --- 3. stability ------------------------------------------------------- */

function computeStabilities(tree: CondensedTree): Map<number, number> {
  const stability = new Map<number, number>();
  for (const c of tree.clusters) stability.set(c, 0);
  for (const e of tree.edges) {
    const birth = tree.birth.get(e.parent) ?? 0;
    const contribution = (e.lambda - birth) * e.childSize;
    if (!Number.isFinite(contribution)) continue; // defensive against ∞ λ
    stability.set(e.parent, (stability.get(e.parent) ?? 0) + contribution);
  }
  return stability;
}

/* --- 4. selection ------------------------------------------------------- */

/**
 * Excess of Mass. Process clusters bottom-up (children carry larger ids than
 * their parent). A cluster is selected when its own stability is at least the
 * summed propagated stability of its sub-clusters; otherwise the sub-clusters
 * stand and the parent propagates their combined stability upward. Selecting a
 * cluster deselects every descendant so the result is disjoint.
 */
function selectEoM(
  tree: CondensedTree,
  stability: Map<number, number>,
): Set<number> {
  const propagated = new Map<number, number>(stability);
  const isCluster = new Map<number, boolean>();
  for (const c of tree.clusters) isCluster.set(c, true);

  const order = tree.clusters.slice().sort((a, b) => b - a); // bottom-up
  for (const node of order) {
    const children = tree.childClusters.get(node) ?? [];
    let childSum = 0;
    for (const ch of children) childSum += propagated.get(ch) ?? 0;
    if (childSum > (stability.get(node) ?? 0)) {
      isCluster.set(node, false);
      propagated.set(node, childSum);
    } else {
      // Select this cluster; drop all descendants.
      propagated.set(node, stability.get(node) ?? 0);
      const stack = [...children];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        isCluster.set(cur, false);
        for (const ch of tree.childClusters.get(cur) ?? []) stack.push(ch);
      }
    }
  }

  return new Set(tree.clusters.filter((c) => isCluster.get(c)));
}

/** Leaf selection — every cluster with no sub-clusters. Finer than EoM. */
function selectLeaves(tree: CondensedTree): Set<number> {
  const selected = new Set<number>();
  for (const c of tree.clusters) {
    if ((tree.childClusters.get(c) ?? []).length === 0) selected.add(c);
  }
  return selected;
}

/* --- 5. membership ------------------------------------------------------ */

function membersOf(
  dendro: Dendrogram,
  tree: CondensedTree,
  selected: ReadonlySet<number>,
): number[][] {
  // Each point falls out of exactly one cluster — find that cluster, then walk
  // up to the nearest selected ancestor (HDBSCAN's `do_labelling`).
  const pointParent = new Map<number, number>();
  for (const e of tree.edges) {
    if (e.child < dendro.n) pointParent.set(e.child, e.parent);
  }

  const byCluster = new Map<number, number[]>();
  for (const [point, leafCluster] of pointParent) {
    let c: number | undefined = leafCluster;
    while (c !== undefined && !selected.has(c)) c = tree.parentCluster.get(c);
    if (c === undefined) continue; // noise
    const list = byCluster.get(c);
    if (list) list.push(point);
    else byCluster.set(c, [point]);
  }

  const out: number[][] = [];
  for (const points of byCluster.values()) {
    if (points.length < 2) continue; // match legacy size≥2 floor
    const cacheIds = points
      .map((p) => dendro.cacheId[p]!)
      .sort((a, b) => a - b);
    out.push(cacheIds);
  }
  // Canonical cluster order: by smallest member id.
  out.sort((a, b) => a[0]! - b[0]!);
  return out;
}
