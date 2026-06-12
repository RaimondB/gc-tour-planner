// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { UndirectedGraph } from "graphology";
import { describe, expect, it } from "vitest";
import { leidenCommunities } from "./leiden-detect.js";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clique(g: UndirectedGraph, ids: string[]): void {
  for (const id of ids) if (!g.hasNode(id)) g.addNode(id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      g.addEdge(ids[i]!, ids[j]!, { weight: 1 });
    }
  }
}

/** Group node ids by their assigned community label. */
function communities(mapping: Record<string, number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [node, c] of Object.entries(mapping)) {
    const list = out.get(c);
    if (list) list.push(node);
    else out.set(c, [node]);
  }
  return out;
}

/** True iff `members` induce a single connected component in `g`. */
function isConnected(g: UndirectedGraph, members: string[]): boolean {
  if (members.length <= 1) return true;
  const set = new Set(members);
  const seen = new Set<string>([members[0]!]);
  const queue = [members[0]!];
  while (queue.length) {
    const v = queue.shift()!;
    g.forEachNeighbor(v, (u) => {
      if (set.has(u) && !seen.has(u)) {
        seen.add(u);
        queue.push(u);
      }
    });
  }
  return seen.size === members.length;
}

describe("leidenCommunities", () => {
  it("splits two cliques joined by a single bridge into two connected communities", () => {
    const g = new UndirectedGraph();
    clique(g, ["1", "2", "3", "4"]);
    clique(g, ["5", "6", "7", "8"]);
    g.addEdge("1", "5", { weight: 1 }); // bridge

    const mapping = leidenCommunities(g, { resolution: 1, rng: seeded(42) });
    const comms = communities(mapping);
    expect(comms.size).toBe(2);
    for (const members of comms.values()) {
      expect(isConnected(g, members)).toBe(true);
    }
  });

  it("guarantees every returned community is internally connected", () => {
    // Three cliques in a chain — Leiden's refinement must never emit a
    // community whose members are split across the graph.
    const g = new UndirectedGraph();
    clique(g, ["1", "2", "3", "4"]);
    clique(g, ["5", "6", "7", "8"]);
    clique(g, ["9", "10", "11", "12"]);
    g.addEdge("4", "5", { weight: 1 });
    g.addEdge("8", "9", { weight: 1 });

    const mapping = leidenCommunities(g, { resolution: 1, rng: seeded(7) });
    for (const members of communities(mapping).values()) {
      expect(isConnected(g, members)).toBe(true);
    }
  });

  it("keeps a single clique together as one community", () => {
    const g = new UndirectedGraph();
    clique(g, ["1", "2", "3", "4", "5"]);
    const mapping = leidenCommunities(g, { resolution: 1, rng: seeded(1) });
    expect(communities(mapping).size).toBe(1);
  });

  it("is deterministic for a fixed seed", () => {
    const build = () => {
      const g = new UndirectedGraph();
      clique(g, ["1", "2", "3", "4"]);
      clique(g, ["5", "6", "7", "8"]);
      g.addEdge("1", "5", { weight: 1 });
      return g;
    };
    const a = leidenCommunities(build(), { resolution: 1, rng: seeded(99) });
    const b = leidenCommunities(build(), { resolution: 1, rng: seeded(99) });
    expect(b).toEqual(a);
  });

  it("returns an empty map for an empty graph", () => {
    expect(
      leidenCommunities(new UndirectedGraph(), {
        resolution: 1,
        rng: seeded(1),
      }),
    ).toEqual({});
  });
});
