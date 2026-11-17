// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  evaluatePath,
  repairPath,
  solveOrienteering,
  type OrienteeringNode,
  type OrienteeringProblem,
} from "./orienteering.js";

/**
 * Points on a plane (metres), travel = straight-line distance at 1 m/s so the
 * numbers stay readable. S and E are given separately.
 */
function problem(
  points: readonly [number, number][],
  opts: {
    start?: [number, number];
    end?: [number, number];
    budget: number;
    visit?: number;
    nodes?: Partial<OrienteeringNode>[];
    keepTogether?: boolean;
    interleave?: boolean;
    varietyWeight?: number;
  },
): OrienteeringProblem {
  const start = opts.start ?? [0, 0];
  const end = opts.end ?? start;
  const d = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
  return {
    nodes: points.map((_, i) => ({
      id: i + 1,
      prize: 1,
      visitSeconds: opts.visit ?? 0,
      type: "Traditional",
      adventureId: null,
      stageSequence: null,
      sequential: false,
      ...opts.nodes?.[i],
    })),
    fromStart: points.map((q) => d(start, q)),
    toEnd: points.map((q) => d(q, end)),
    between: points.map((a) => points.map((b) => d(a, b))),
    startToEnd: d(start, end),
    budgetSeconds: opts.budget,
    keepTogether: opts.keepTogether ?? true,
    interleave: opts.interleave ?? true,
    varietyWeight: opts.varietyWeight ?? 0,
  };
}

describe("solveOrienteering", () => {
  it("is infeasible with an empty order when even S → E doesn't fit", () => {
    const res = solveOrienteering(
      problem([[10, 0]], { start: [0, 0], end: [100, 0], budget: 50 }),
    );
    expect(res.feasible).toBe(false);
    expect(res.order).toEqual([]);
  });

  it("plans an open path: from S to a different E within the budget", () => {
    // Caches strung along the way from S (0,0) to E (100,0).
    const p = problem(
      [
        [25, 0],
        [50, 0],
        [75, 0],
        [50, 80],
      ],
      { start: [0, 0], end: [100, 0], budget: 130 },
    );
    const res = solveOrienteering(p);
    expect(res.feasible).toBe(true);
    // The three on-the-way caches fit (100 s); the detour one doesn't.
    expect(res.order).toEqual([0, 1, 2]);
    expect(res.seconds).toBeCloseTo(100);
  });

  it("counts visit time against the budget", () => {
    const p = problem(
      [
        [25, 0],
        [50, 0],
        [75, 0],
      ],
      { start: [0, 0], end: [100, 0], budget: 165, visit: 30 },
    );
    // 100 s walking + 30 s per cache → at most 2 caches.
    expect(solveOrienteering(p).order).toHaveLength(2);
  });

  it("prefers higher prizes when time is short", () => {
    const p = problem(
      [
        [0, 30],
        [0, -30],
      ],
      {
        budget: 70,
        nodes: [{ prize: 1 }, { prize: 3 }],
      },
    );
    expect(solveOrienteering(p).order).toEqual([1]);
  });

  it("with variety, prefers a different type over a second of the same", () => {
    // Two Traditionals close together, a Multi the other way. Two Traditionals
    // = 22 s, Traditional + Multi = 44 s, all three = 46 s: the 45 s budget
    // fits two caches.
    const p = (varietyWeight: number) =>
      problem(
        [
          [0, 10],
          [0, 11],
          [0, -12],
        ],
        {
          budget: 45,
          varietyWeight,
          nodes: [
            { type: "Traditional" },
            { type: "Traditional" },
            { type: "Multi" },
          ],
        },
      );
    const types = (v: number) => {
      const prob = p(v);
      return solveOrienteering(prob)
        .order.map((i) => prob.nodes[i]!.type)
        .sort();
    };
    // Same score without variety → the quicker pair wins.
    expect(types(0)).toEqual(["Traditional", "Traditional"]);
    expect(types(4)).toEqual(["Multi", "Traditional"]);
  });

  it("keeps an adventure together: all remaining stages or none", () => {
    const al = { adventureId: "A", type: "Adventure Lab" };
    const p = problem(
      [
        [10, 0],
        [20, 0],
        [200, 0],
        [0, 15],
      ],
      {
        budget: 100,
        nodes: [
          { ...al, stageSequence: 1 },
          { ...al, stageSequence: 2 },
          { ...al, stageSequence: 3 },
          {},
        ],
      },
    );
    const res = solveOrienteering(p);
    // Stage 3 is too far, so the whole adventure is out.
    expect(res.order).toEqual([3]);
  });

  it("allows partial adventures when keep-together is off", () => {
    const al = { adventureId: "A", type: "Adventure Lab" };
    const p = problem(
      [
        [10, 0],
        [20, 0],
        [200, 0],
      ],
      {
        budget: 100,
        keepTogether: false,
        nodes: [
          { ...al, stageSequence: 1 },
          { ...al, stageSequence: 2 },
          { ...al, stageSequence: 3 },
        ],
      },
    );
    expect(solveOrienteering(p).order.sort()).toEqual([0, 1]);
  });

  it("visits a linear adventure's stages in stage order", () => {
    // Stage 2 sits nearest S, but stage 1 must come first.
    const al = { adventureId: "A", sequential: true, type: "Adventure Lab" };
    const p = problem(
      [
        [30, 0],
        [10, 0],
      ],
      {
        budget: 1000,
        nodes: [
          { ...al, stageSequence: 1 },
          { ...al, stageSequence: 2 },
        ],
      },
    );
    const res = solveOrienteering(p);
    expect(res.order).toEqual([0, 1]);
    expect(res.valid).toBe(true);
  });

  it("keeps a non-interleaving adventure contiguous", () => {
    const al = { adventureId: "A", type: "Adventure Lab" };
    const p = problem(
      [
        [10, 0],
        [30, 0],
        [20, 0],
      ],
      {
        budget: 1000,
        interleave: false,
        nodes: [{ ...al, stageSequence: 1 }, { ...al, stageSequence: 2 }, {}],
      },
    );
    const res = solveOrienteering(p);
    const pos = (i: number) => res.order.indexOf(i);
    expect(Math.abs(pos(0) - pos(1))).toBe(1);
  });

  it("is deterministic", () => {
    const p = randomProblem(42, 12);
    expect(solveOrienteering(p)).toEqual(solveOrienteering(p));
  });

  it("never returns an infeasible or invalid route, and gets close to optimal", () => {
    let total = 0;
    let optimal = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const p = randomProblem(seed, 7);
      const res = solveOrienteering(p);
      expect(res.feasible).toBe(true);
      expect(res.valid).toBe(true);
      const best = bruteForce(p);
      expect(res.score).toBeLessThanOrEqual(best + 1e-9);
      total += res.score;
      optimal += best;
    }
    // Across instances, the heuristic keeps ≥ 95 % of the optimal score.
    expect(total / optimal).toBeGreaterThanOrEqual(0.95);
  });
});

describe("repairPath", () => {
  it("drops the least valuable stops until the old route fits again", () => {
    const p = problem(
      [
        [25, 0],
        [50, 0],
        [75, 0],
      ],
      {
        start: [0, 0],
        end: [100, 0],
        budget: 165,
        visit: 30,
        nodes: [{ prize: 1 }, { prize: 5 }, { prize: 1 }],
      },
    );
    const repaired = repairPath([0, 1, 2], p);
    expect(evaluatePath(repaired, p).feasible).toBe(true);
    expect(repaired).toContain(1);
    expect(repaired).toHaveLength(2);
  });

  it("removes ids that are no longer candidates", () => {
    const p = problem([[10, 0]], { budget: 1000 });
    expect(repairPath([0, 7, -1], p)).toEqual([0]);
  });
});

/* --- helpers -------------------------------------------------------------- */

/** Small seeded PRNG (mulberry32) so random instances are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProblem(seed: number, n: number): OrienteeringProblem {
  const r = rng(seed);
  const points: [number, number][] = Array.from({ length: n }, () => [
    r() * 1000,
    r() * 1000,
  ]);
  return problem(points, {
    start: [500, 0],
    end: [500, 1000],
    budget: 1500 + r() * 1500,
    visit: 60,
    keepTogether: false,
    nodes: points.map(() => ({ prize: 1 + Math.floor(r() * 4) })),
  });
}

/** Best score over every subset in its best order (n ≤ 8). */
function bruteForce(p: OrienteeringProblem): number {
  const n = p.nodes.length;
  let best = 0;
  const permute = (rest: number[], prefix: number[]): void => {
    const ev = evaluatePath(prefix, p);
    if (!ev.feasible) return;
    if (ev.valid) best = Math.max(best, ev.score);
    for (let k = 0; k < rest.length; k += 1) {
      permute(
        [...rest.slice(0, k), ...rest.slice(k + 1)],
        [...prefix, rest[k]!],
      );
    }
  };
  permute(
    Array.from({ length: n }, (_, i) => i),
    [],
  );
  return best;
}
