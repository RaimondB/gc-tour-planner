// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Open-path orienteering for the ad-hoc walk (ADR-0040, FR-T18): from a fixed
 * start S to a fixed end E, pick and order caches to maximise the profile score
 * while travel + visits fit the time budget. Pure and deterministic (fixed
 * iteration order, no randomness) — the replan's stability rule compares
 * solutions, and the same module can later run in the browser.
 *
 * Node indices 0..n-1 refer to `nodes`; S and E only appear through the
 * `fromStart` / `toEnd` rows.
 */

export interface OrienteeringNode {
  id: number;
  /** Value of visiting this cache (≥ 0). */
  prize: number;
  visitSeconds: number;
  /** Grouping key for variety's diminishing returns (the cache type). */
  type: string;
  adventureId: string | null;
  stageSequence: number | null;
  /** Linear Adventure Lab stage: must follow `stageSequence` order. */
  sequential: boolean;
}

export interface OrienteeringProblem {
  nodes: readonly OrienteeringNode[];
  /** Seconds S → node i; `null` = unreachable. */
  fromStart: readonly (number | null)[];
  /** Seconds node i → E; `null` = unreachable. */
  toEnd: readonly (number | null)[];
  /** Seconds node i → node j; `null` = unreachable. */
  between: readonly (readonly (number | null)[])[];
  /** Seconds S → E directly (the empty walk). */
  startToEnd: number;
  /** Travel + visits must not exceed this. */
  budgetSeconds: number;
  /** Adventure Lab stages: all remaining stages of an adventure, or none. */
  keepTogether: boolean;
  /** When false, an adventure's stages stay contiguous in the path. */
  interleave: boolean;
  /** Diminishing returns within a type: k-th counts p / (1 + 0.5·v·k). */
  varietyWeight: number;
}

export interface PathEvaluation {
  seconds: number;
  score: number;
  /** Fits the budget and every leg is routable. */
  feasible: boolean;
  /** Adventure Lab ordering / contiguity rules hold. */
  valid: boolean;
}

export interface OrienteeringResult extends PathEvaluation {
  /** Visit order as node indices (excluding S and E). */
  order: number[];
}

const MAX_ROUNDS = 50;

/** Seconds of a path S → order → E (travel + visits); Infinity if unroutable. */
export function pathSeconds(
  order: readonly number[],
  p: OrienteeringProblem,
): number {
  if (order.length === 0) return p.startToEnd;
  let total = p.fromStart[order[0]!] ?? Number.POSITIVE_INFINITY;
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k]!;
    total += p.nodes[i]!.visitSeconds;
    const next = order[k + 1];
    total +=
      next === undefined
        ? (p.toEnd[i] ?? Number.POSITIVE_INFINITY)
        : (p.between[i]?.[next] ?? Number.POSITIVE_INFINITY);
  }
  return total;
}

/** Profile score of a set of visited nodes, with variety's diminishing returns. */
export function pathScore(
  order: readonly number[],
  p: OrienteeringProblem,
): number {
  const byType = new Map<string, number[]>();
  for (const i of order) {
    const n = p.nodes[i]!;
    (byType.get(n.type) ?? byType.set(n.type, []).get(n.type)!).push(n.prize);
  }
  let score = 0;
  for (const prizes of byType.values()) {
    prizes.sort((a, b) => b - a);
    prizes.forEach((prize, k) => {
      score += prize / (1 + 0.5 * p.varietyWeight * k);
    });
  }
  return score;
}

/** Adventure Lab rules: linear stage order and, without interleave, contiguity. */
export function isValidPath(
  order: readonly number[],
  p: OrienteeringProblem,
): boolean {
  const lastSeq = new Map<string, number>();
  const lastPos = new Map<string, number>();
  for (let k = 0; k < order.length; k += 1) {
    const n = p.nodes[order[k]!]!;
    if (n.adventureId === null) continue;
    if (n.sequential && n.stageSequence !== null) {
      const prev = lastSeq.get(n.adventureId);
      if (prev !== undefined && n.stageSequence < prev) return false;
      lastSeq.set(n.adventureId, n.stageSequence);
    }
    if (!p.interleave) {
      const prevPos = lastPos.get(n.adventureId);
      if (prevPos !== undefined && prevPos !== k - 1) return false;
      lastPos.set(n.adventureId, k);
    }
  }
  if (p.keepTogether) {
    // Every adventure in the path must be complete.
    const inPath = new Set(order);
    for (const i of order) {
      const a = p.nodes[i]!.adventureId;
      if (a === null) continue;
      for (const j of unitMembers(a, p)) if (!inPath.has(j)) return false;
    }
  }
  return true;
}

export function evaluatePath(
  order: readonly number[],
  p: OrienteeringProblem,
): PathEvaluation {
  const seconds = pathSeconds(order, p);
  return {
    seconds,
    score: pathScore(order, p),
    feasible: Number.isFinite(seconds) && seconds <= p.budgetSeconds,
    valid: isValidPath(order, p),
  };
}

/**
 * Solve: greedy insertion by score gained per second spent, then improvement
 * rounds (2-opt + or-opt to save time, re-insertion, unit swaps) until nothing
 * improves. `seed` is an optional starting order (e.g. a locked prefix is the
 * caller's job — this module always starts from S).
 */
export function solveOrienteering(
  p: OrienteeringProblem,
  seed: readonly number[] = [],
): OrienteeringResult {
  if (!(p.startToEnd <= p.budgetSeconds)) {
    return { order: [], ...evaluatePath([], p), feasible: false };
  }
  let order = sanitizeSeed(seed, p);
  order = insertGreedily(order, p);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const before = evaluatePath(order, p);
    order = shortenPath(order, p);
    order = insertGreedily(order, p);
    order = swapUnits(order, p);
    const after = evaluatePath(order, p);
    if (!better(after, before)) break;
  }
  return { order, ...evaluatePath(order, p) };
}

/**
 * Make an order feasible and valid again by dropping whole units — the one
 * giving up the least score per second saved first. Used to re-score the
 * previous tentative route for the stability rule.
 */
export function repairPath(
  order: readonly number[],
  p: OrienteeringProblem,
): number[] {
  let current = order.filter((i) => i >= 0 && i < p.nodes.length);
  current = dropIncompleteUnits(current, p);
  for (;;) {
    const ev = evaluatePath(current, p);
    if ((ev.feasible && ev.valid) || current.length === 0) return current;
    let bestCut: number[] | null = null;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (const unit of unitsIn(current, p)) {
      const without = current.filter((i) => !unit.includes(i));
      const evW = evaluatePath(without, p);
      const lost = ev.score - evW.score;
      const saved = Math.max(1e-9, ev.seconds - evW.seconds);
      const ratio = evW.valid ? lost / saved : Number.POSITIVE_INFINITY;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestCut = without;
      }
    }
    if (!bestCut) return [];
    current = bestCut;
  }
}

/* --- internals ------------------------------------------------------------ */

/** Strictly better: higher score, or the same score in less time. */
function better(a: PathEvaluation, b: PathEvaluation): boolean {
  const eps = 1e-9;
  if (a.score > b.score + eps) return true;
  return Math.abs(a.score - b.score) <= eps && a.seconds < b.seconds - eps;
}

function unitMembers(adventureId: string, p: OrienteeringProblem): number[] {
  const members: number[] = [];
  p.nodes.forEach((n, i) => {
    if (n.adventureId === adventureId) members.push(i);
  });
  return members.sort(
    (a, b) =>
      (p.nodes[a]!.stageSequence ?? 0) - (p.nodes[b]!.stageSequence ?? 0) ||
      a - b,
  );
}

/** Insertion units: a whole adventure when keepTogether, else single nodes. */
function allUnits(p: OrienteeringProblem): number[][] {
  const units: number[][] = [];
  const seen = new Set<string>();
  p.nodes.forEach((n, i) => {
    if (p.keepTogether && n.adventureId !== null) {
      if (seen.has(n.adventureId)) return;
      seen.add(n.adventureId);
      units.push(unitMembers(n.adventureId, p));
    } else {
      units.push([i]);
    }
  });
  return units;
}

function unitsIn(order: readonly number[], p: OrienteeringProblem): number[][] {
  const inPath = new Set(order);
  return allUnits(p).filter((u) => u.every((i) => inPath.has(i)));
}

function dropIncompleteUnits(
  order: readonly number[],
  p: OrienteeringProblem,
): number[] {
  if (!p.keepTogether) return [...order];
  const inPath = new Set(order);
  const incomplete = new Set<string>();
  for (const i of order) {
    const a = p.nodes[i]!.adventureId;
    if (a !== null && unitMembers(a, p).some((j) => !inPath.has(j))) {
      incomplete.add(a);
    }
  }
  return order.filter((i) => {
    const a = p.nodes[i]!.adventureId;
    return a === null || !incomplete.has(a);
  });
}

function sanitizeSeed(
  seed: readonly number[],
  p: OrienteeringProblem,
): number[] {
  const unique = [...new Set(seed)];
  return repairPath(unique, p);
}

/** The order with `unit` inserted as a block at `pos`. */
function withBlock(
  order: readonly number[],
  unit: readonly number[],
  pos: number,
): number[] {
  return [...order.slice(0, pos), ...unit, ...order.slice(pos)];
}

function insertGreedily(
  start: readonly number[],
  p: OrienteeringProblem,
): number[] {
  let order = [...start];
  for (;;) {
    const inPath = new Set(order);
    const base = evaluatePath(order, p);
    let best: number[] | null = null;
    let bestRatio = Number.NEGATIVE_INFINITY;
    let bestSeconds = Number.POSITIVE_INFINITY;
    for (const unit of allUnits(p)) {
      if (unit.some((i) => inPath.has(i))) continue;
      for (let pos = 0; pos <= order.length; pos += 1) {
        const cand = withBlock(order, unit, pos);
        const ev = evaluatePath(cand, p);
        if (!ev.feasible || !ev.valid) continue;
        const gain = ev.score - base.score;
        if (gain <= 0) continue;
        const ratio = gain / Math.max(1, ev.seconds - base.seconds);
        if (
          ratio > bestRatio + 1e-12 ||
          (Math.abs(ratio - bestRatio) <= 1e-12 && ev.seconds < bestSeconds)
        ) {
          bestRatio = ratio;
          bestSeconds = ev.seconds;
          best = cand;
        }
      }
    }
    if (!best) return order;
    order = best;
  }
}

/** 2-opt + or-opt with both ends fixed; only accepts valid, shorter paths. */
function shortenPath(
  start: readonly number[],
  p: OrienteeringProblem,
): number[] {
  let order = [...start];
  let current = pathSeconds(order, p);
  let improved = true;
  while (improved) {
    improved = false;
    // 2-opt: reverse order[i..j].
    for (let i = 0; i < order.length - 1 && !improved; i += 1) {
      for (let j = i + 1; j < order.length && !improved; j += 1) {
        const cand = [
          ...order.slice(0, i),
          ...order.slice(i, j + 1).reverse(),
          ...order.slice(j + 1),
        ];
        const s = pathSeconds(cand, p);
        if (s < current - 1e-9 && isValidPath(cand, p)) {
          order = cand;
          current = s;
          improved = true;
        }
      }
    }
    // Or-opt: move a segment of 1–3 stops elsewhere.
    for (let len = 1; len <= 3 && !improved; len += 1) {
      for (let i = 0; i + len <= order.length && !improved; i += 1) {
        const seg = order.slice(i, i + len);
        const rest = [...order.slice(0, i), ...order.slice(i + len)];
        for (let pos = 0; pos <= rest.length && !improved; pos += 1) {
          if (pos === i) continue;
          const cand = withBlock(rest, seg, pos);
          const s = pathSeconds(cand, p);
          if (s < current - 1e-9 && isValidPath(cand, p)) {
            order = cand;
            current = s;
            improved = true;
          }
        }
      }
    }
  }
  return order;
}

/** Swap one unit in the path for one outside it when that scores better. */
function swapUnits(start: readonly number[], p: OrienteeringProblem): number[] {
  const order = [...start];
  const base = evaluatePath(order, p);
  const inPath = new Set(order);
  const outside = allUnits(p).filter((u) => u.every((i) => !inPath.has(i)));
  for (const unitIn of unitsIn(order, p)) {
    const without = order.filter((i) => !unitIn.includes(i));
    for (const unitOut of outside) {
      for (let pos = 0; pos <= without.length; pos += 1) {
        const cand = withBlock(without, unitOut, pos);
        const ev = evaluatePath(cand, p);
        if (ev.feasible && ev.valid && better(ev, base)) return cand;
      }
    }
  }
  return order;
}
