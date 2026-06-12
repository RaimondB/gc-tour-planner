// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Tsp } from "@gctp/shared";

/**
 * Pass 2 post-trim: drop caches whose presence adds more walking distance
 * than they're worth.
 *
 * Why this exists: cluster discovery (Pass 1) can keep caches that sit
 * behind a single-bridge barrier — a motorway, river, fenced industrial
 * estate. Their haversine distance to cluster-mates looks fine, but OSRM's
 * walking route goes the long way around. The TSP order then pays for
 * that detour twice (out + back). Removing such a cache cuts the tour
 * length by a lot while losing only one cache from the visit list.
 *
 * Two modes:
 *
 *   • **Fixed-threshold** (legacy; `budgetMeters` unset). Drop any cache
 *     whose marginal exceeds `thresholdMeters`, re-2-opt, repeat. Route-blind
 *     — it cuts a perfectly fine cache the moment its detour crosses the
 *     threshold even when the loop is nowhere near the distance budget.
 *
 *   • **Budget-aware** (`budgetMeters` set). Route the *full* cluster and
 *     trim only when it earns its keep:
 *       – loop ≤ budget: drop only genuine outliers — caches whose marginal
 *         exceeds the high `outlierThresholdMeters` floor (a cache stuck
 *         behind a single-bridge barrier). Normal caches stay, so the loop
 *         fills the unused budget instead of being cut to a fixed metre cap.
 *       – loop > budget: iteratively drop the worst-marginal cache (the one
 *         whose removal shortens the loop most) and re-2-opt until the loop
 *         fits the budget.
 *     The Timefold solver already maximises caches-within-budget upstream;
 *     this mode keeps the trim from undoing that before the budget is full.
 *
 * Common machinery (both modes):
 *   1. Compute the "marginal cost" of every interior cache k:
 *        marginal(k) = d(prev, k) + d(k, next) − d(prev, next)
 *      i.e. how much extra walking it adds vs. the straight prev→next leg.
 *   2. Pick the worst-marginal cache; if the mode's drop rule fires, remove
 *      it, run 2-opt on the reduced set, and repeat.
 *   3. Stop when the drop rule no longer fires OR when only `minRemaining`
 *      caches are left (safety floor — never strip the tour to nothing).
 *
 * Endpoints (cache 0 and cache N-1) are intentionally NOT considered in
 * the marginal calculation: their cost depends on parking distances which
 * the caller may not have fetched for every cache. After dropping an
 * interior cache and re-TSP'ing the surviving set, a former endpoint may
 * become interior on the next iteration and get caught there.
 *
 * `distances` is N × N over the FULL original cache id set (indexed by
 * position in `originalIds`). `orderedIds` is the current TSP order
 * expressed as cache ids (not indices); we map back to indices internally.
 */

export interface MarginalTrimInput {
  /** Cache ids in current TSP visit order. Length ≥ 2. */
  orderedIds: readonly number[];
  /**
   * Cache ids in the column/row ordering of `distances`. Must include every
   * id in `orderedIds`. Surviving ids stay in this array even after a drop
   * — callers don't need to rebuild the matrix.
   */
  originalIds: readonly number[];
  /**
   * N×N walking matrix indexed by position in `originalIds`. `null` for
   * pairs OSRM couldn't route (treated as ∞ in the marginal calc, so such
   * a leg never wins a comparison).
   */
  distances: readonly (readonly (number | null)[])[];
  /**
   * Hard limit: a cache is trimmed only if its marginal cost exceeds this.
   * Typical callers compute `max(absoluteFloorM, ratio × medianEdgeM)` and
   * pass the result. 0 disables trimming entirely.
   */
  thresholdMeters: number;
  /** Never let the surviving tour fall below this many caches. */
  minRemaining: number;
  /**
   * Enables **budget-aware** mode (see the module doc). When set, the routed
   * loop length is compared against this budget: caches are kept while the
   * loop fits (subject to `outlierThresholdMeters`) and only trimmed to bring
   * an over-budget loop back under it. The loop length includes the parking
   * closure when `parkingToCacheM`/`cacheToParkingM` are supplied. Leave
   * unset for the legacy fixed-threshold behaviour.
   */
  budgetMeters?: number;
  /**
   * Budget-aware mode only: the marginal-cost above which a cache counts as a
   * genuine outlier (behind-barrier) and is dropped even when the loop is
   * already within budget. Should sit well above a normal inter-cache leg —
   * callers typically pass a multiple of `maxLinkMeters`. Defaults to
   * `thresholdMeters` when omitted.
   */
  outlierThresholdMeters?: number;
  /**
   * Optional safety cap on iterations. Default = `orderedIds.length` — the
   * trim could in principle drop every cache, but we want bounded work.
   */
  maxIterations?: number;
  /**
   * Optional walking distance from parking to each cache, indexed by
   * position in `originalIds`. When both this AND `cacheToParkingM` are
   * provided, the trim ALSO considers the first and last cache in the
   * tour as drop candidates — that's where a cache stuck behind a
   * single-bridge barrier typically ends up. Without them, the trim
   * conservatively keeps endpoints and the bad cache survives.
   */
  parkingToCacheM?: readonly number[];
  /** Walking distance from each cache back to parking. Symmetry partner to `parkingToCacheM`. */
  cacheToParkingM?: readonly number[];
  /**
   * Async TSP solve used to re-order the survivors after a drop. Injected so
   * the planner runs it on the worker pool (ADR-0014) instead of blocking the
   * event loop. Defaults to a synchronous in-process `Tsp.solveTwoOpt` (used by
   * unit tests, which don't have a pool).
   */
  solve?: (
    distances: readonly (readonly (number | null)[])[],
    startIndex: number,
  ) => Promise<{ order: number[] }>;
}

export interface MarginalTrimResult {
  /** New TSP order over the surviving caches (cache ids, not indices). */
  orderedIds: number[];
  /** Cache ids that were dropped, in the order they were trimmed. */
  droppedIds: number[];
  /** Sum of the marginal costs of the dropped caches. */
  savedMeters: number;
}

export async function trimMarginalCaches(
  input: MarginalTrimInput,
): Promise<MarginalTrimResult> {
  const {
    originalIds,
    distances,
    thresholdMeters,
    minRemaining,
    maxIterations = input.orderedIds.length,
  } = input;
  // Worker-pool solve when injected; synchronous fallback otherwise (tests).
  const solve =
    input.solve ??
    ((d, s): Promise<{ order: number[] }> =>
      Promise.resolve(Tsp.solveTwoOpt(d, s)));

  const budgetMode =
    input.budgetMeters !== undefined && Number.isFinite(input.budgetMeters);
  const outlierThreshold = input.outlierThresholdMeters ?? thresholdMeters;

  // No-op fast path. In budget-aware mode the budget + outlier floor govern
  // drops, so a `thresholdMeters <= 0` (legacy "disabled") sentinel doesn't
  // short-circuit it.
  if (
    (!budgetMode && thresholdMeters <= 0) ||
    input.orderedIds.length <= Math.max(2, minRemaining) ||
    input.orderedIds.length < 3
  ) {
    return {
      orderedIds: input.orderedIds.slice(),
      droppedIds: [],
      savedMeters: 0,
    };
  }

  // Build a lookup from cache id → index in the full distances matrix.
  const idToIdx = new Map<number, number>();
  for (let i = 0; i < originalIds.length; i += 1) {
    idToIdx.set(originalIds[i]!, i);
  }
  const distAt = (idA: number, idB: number): number => {
    const a = idToIdx.get(idA);
    const b = idToIdx.get(idB);
    if (a === undefined || b === undefined) return Number.POSITIVE_INFINITY;
    const v = distances[a]?.[b];
    return v === null || v === undefined ? Number.POSITIVE_INFINITY : v;
  };

  const parkingToCacheM = input.parkingToCacheM;
  const cacheToParkingM = input.cacheToParkingM;
  const endpointsEligible = !!(parkingToCacheM && cacheToParkingM);
  const parkingToCache = (id: number): number => {
    const idx = idToIdx.get(id);
    if (idx === undefined || !parkingToCacheM) return Number.POSITIVE_INFINITY;
    const v = parkingToCacheM[idx];
    return v === undefined || !Number.isFinite(v)
      ? Number.POSITIVE_INFINITY
      : v;
  };
  const cacheToParking = (id: number): number => {
    const idx = idToIdx.get(id);
    if (idx === undefined || !cacheToParkingM) return Number.POSITIVE_INFINITY;
    const v = cacheToParkingM[idx];
    return v === undefined || !Number.isFinite(v)
      ? Number.POSITIVE_INFINITY
      : v;
  };

  // Routed loop length over a cache order: the inter-cache legs plus the
  // parking closure (parking → first, last → parking) when parking distances
  // are available. An unroutable leg makes the loop "infinitely long", which
  // budget mode reads as over-budget and tries to repair by trimming.
  const loopLength = (order: readonly number[]): number => {
    let total = 0;
    for (let i = 0; i < order.length - 1; i += 1) {
      total += distAt(order[i]!, order[i + 1]!);
    }
    if (endpointsEligible && order.length > 0) {
      total += parkingToCache(order[0]!);
      total += cacheToParking(order[order.length - 1]!);
    }
    return total;
  };

  let surviving = input.orderedIds.slice();
  const droppedIds: number[] = [];
  let savedMeters = 0;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    if (surviving.length <= minRemaining) break;
    if (surviving.length < 3) break;

    let worstIdx = -1;
    // Track the global worst (highest) marginal across endpoints + interior.
    // The drop decision below applies the mode-specific rule; here we just
    // find the best candidate. Starts at −∞ so the single worst cache always
    // surfaces (budget mode needs it even below `thresholdMeters`).
    let worstMarginal = Number.NEGATIVE_INFINITY;

    // Endpoint marginals when parking distances are available. The
    // user's pathological case — a cache stuck behind a single-bridge
    // barrier — typically lands at the tour's end (e.g. cache 3592 with
    // a 2.3 km leg from second-last and a 1.2 km return to parking),
    // and conservatively skipping endpoints would never trim it.
    if (endpointsEligible) {
      // First cache: marginal = parkingToCache(first) + d(first, second)
      //                          − parkingToCache(second)
      const first = surviving[0]!;
      const second = surviving[1]!;
      const dToFirst = parkingToCache(first);
      const dFirstSecond = distAt(first, second);
      const dToSecond = parkingToCache(second);
      if (
        Number.isFinite(dToFirst) &&
        Number.isFinite(dFirstSecond) &&
        Number.isFinite(dToSecond)
      ) {
        const marginal = dToFirst + dFirstSecond - dToSecond;
        if (marginal > worstMarginal) {
          worstMarginal = marginal;
          worstIdx = 0;
        }
      }
      // Last cache: marginal = d(secondLast, last) + cacheToParking(last)
      //                          − cacheToParking(secondLast)
      const lastPos = surviving.length - 1;
      const last = surviving[lastPos]!;
      const secondLast = surviving[lastPos - 1]!;
      const dSLLast = distAt(secondLast, last);
      const dLastPark = cacheToParking(last);
      const dSLPark = cacheToParking(secondLast);
      if (
        Number.isFinite(dSLLast) &&
        Number.isFinite(dLastPark) &&
        Number.isFinite(dSLPark)
      ) {
        const marginal = dSLLast + dLastPark - dSLPark;
        if (marginal > worstMarginal) {
          worstMarginal = marginal;
          worstIdx = lastPos;
        }
      }
    }

    // Interior caches — always considered.
    for (let p = 1; p < surviving.length - 1; p += 1) {
      const prev = surviving[p - 1]!;
      const here = surviving[p]!;
      const next = surviving[p + 1]!;
      const dPrevHere = distAt(prev, here);
      const dHereNext = distAt(here, next);
      const dPrevNext = distAt(prev, next);
      // If prev → next is unreachable, dropping `here` would break the
      // tour, so we must keep it regardless of marginal cost.
      if (!Number.isFinite(dPrevNext)) continue;
      const marginal = dPrevHere + dHereNext - dPrevNext;
      if (marginal > worstMarginal) {
        worstMarginal = marginal;
        worstIdx = p;
      }
    }

    if (worstIdx < 0) break; // no droppable candidate (e.g. all legs unroutable)

    // Mode-specific drop rule.
    let shouldDrop: boolean;
    if (budgetMode) {
      if (loopLength(surviving) > input.budgetMeters!) {
        // Over budget: drop the worst-marginal cache as long as removing it
        // actually shortens the loop. If even the worst marginal is ~0 the
        // loop is irreducibly long — stop rather than spin.
        shouldDrop = worstMarginal > 0;
      } else {
        // Within budget: keep normal caches, only cut genuine outliers.
        shouldDrop = worstMarginal > outlierThreshold;
      }
    } else {
      shouldDrop = worstMarginal > thresholdMeters;
    }
    if (!shouldDrop) break;

    droppedIds.push(surviving[worstIdx]!);
    savedMeters += worstMarginal;
    surviving = surviving.filter((_, i) => i !== worstIdx);

    // Re-run 2-opt on the surviving set so the order is optimal again.
    // Build a sub-matrix indexed by position in `surviving`.
    const n = surviving.length;
    const subDist: (number | null)[][] = [];
    for (let i = 0; i < n; i += 1) {
      const row: (number | null)[] = [];
      for (let j = 0; j < n; j += 1) {
        row.push(i === j ? 0 : distAt(surviving[i]!, surviving[j]!));
      }
      subDist.push(row);
    }
    const finite = subDist.map((row) =>
      row.map((v) =>
        v === null || !Number.isFinite(v) ? Number.MAX_SAFE_INTEGER : v,
      ),
    );
    const { order } = await solve(finite, 0);
    surviving = order.map((i) => surviving[i]!);
  }

  return {
    orderedIds: surviving,
    droppedIds,
    savedMeters,
  };
}

/**
 * Median of off-diagonal walking distances in a matrix — the natural
 * threshold-scale for the marginal trim. Returns 0 when the matrix is too
 * small or no finite cells exist (caller should fall back to an absolute
 * floor).
 */
export function medianInterCacheDistance(
  distances: readonly (readonly (number | null)[])[],
): number {
  const finite: number[] = [];
  for (let i = 0; i < distances.length; i += 1) {
    const row = distances[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j += 1) {
      if (i === j) continue;
      const v = row[j];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      finite.push(v);
    }
  }
  if (finite.length === 0) return 0;
  finite.sort((a, b) => a - b);
  return finite[Math.floor(finite.length / 2)] ?? 0;
}

/**
 * Resolve the trim threshold from env + the cluster's own median walking
 * distance. The threshold is
 *   min(hardMaxM, max(absoluteFloorM, ratio × median))
 * so that:
 *  - very dense clusters (small median) still need an absolute minimum
 *    detour to be worth trimming (`absoluteFloorM`);
 *  - sparse clusters scale up automatically via the ratio;
 *  - **poisoned clusters** — ones where so many pairs cross a barrier
 *    that the median walking distance is itself huge (river archipelago
 *    case) — cannot let the threshold balloon past `hardMaxM`. Without
 *    the cap, every cache's marginal cost is below the inflated
 *    threshold and nothing gets trimmed; with it, anything > hardMaxM
 *    extra walking is dropped regardless of cluster geometry.
 *  - setting `PLANNER_MARGINAL_DROP_ENABLED=false` disables the trim
 *    entirely (returns 0).
 *
 * Env knobs:
 *   PLANNER_MARGINAL_DROP_ENABLED   (default "true")
 *   PLANNER_MARGINAL_DROP_RATIO     (default 2.0)
 *   PLANNER_MARGINAL_DROP_ABS_M     (default 500)
 *   PLANNER_MARGINAL_DROP_HARD_MAX_M (default 3000)
 */
export function resolveMarginalTrimThreshold(
  distances: readonly (readonly (number | null)[])[],
): number {
  const enabled =
    (process.env.PLANNER_MARGINAL_DROP_ENABLED ?? "true") !== "false";
  if (!enabled) return 0;
  const num = (env: string, fallback: number): number => {
    const raw = process.env[env];
    if (!raw) return fallback;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const ratio = num("PLANNER_MARGINAL_DROP_RATIO", 2.0);
  const absM = num("PLANNER_MARGINAL_DROP_ABS_M", 500);
  const hardMaxM = num("PLANNER_MARGINAL_DROP_HARD_MAX_M", 3000);
  const median = medianInterCacheDistance(distances);
  const scaled = Math.max(absM, ratio * median);
  return Math.min(hardMaxM, scaled);
}

export interface MarginalTrimConfig {
  /**
   * When `true` (default), callers run the trim in budget-aware mode: route
   * the full cluster, keep caches while the loop fits the distance budget,
   * trim only outliers/over-budget. When `false`, fall back to the legacy
   * fixed-threshold trim (`thresholdMeters = maxLinkMeters`).
   */
  budgetAware: boolean;
  /**
   * Multiplier on `maxLinkMeters` that sets the genuine-outlier floor in
   * budget-aware mode: `outlierThresholdMeters = outlierFactor × maxLinkMeters`.
   * A cache only gets cut while the loop is within budget if its detour
   * exceeds this — i.e. it's behind a barrier, not merely on the fringe.
   */
  outlierFactor: number;
}

/**
 * Resolve the budget-aware marginal-trim config from env.
 *
 * Env knobs:
 *   PLANNER_MARGINAL_BUDGET_AWARE    (default "true")
 *   PLANNER_MARGINAL_OUTLIER_FACTOR  (default 2.0)
 */
export function resolveMarginalTrimConfig(): MarginalTrimConfig {
  const budgetAware =
    (process.env.PLANNER_MARGINAL_BUDGET_AWARE ?? "true") !== "false";
  const raw = process.env.PLANNER_MARGINAL_OUTLIER_FACTOR;
  const parsed = raw === undefined ? NaN : Number.parseFloat(raw);
  const outlierFactor = Number.isFinite(parsed) && parsed > 0 ? parsed : 2.0;
  return { budgetAware, outlierFactor };
}
