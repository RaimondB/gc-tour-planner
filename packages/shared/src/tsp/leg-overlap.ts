// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Straight-line overlap proxy for the low-overlap loop solver
 * (`./low-overlap-loop.ts`).
 *
 * The shortest-distance TSP (`./two-opt.ts`) minimises Σ leg distance and is
 * blind to two legs sharing the same street — the cause of the "walk the main
 * street twice" retracing on dense clusters. The low-overlap solver instead
 * minimises `Σ dist + β · retrace`, and needs a CHEAP, DETERMINISTIC,
 * ORDER-INDEPENDENT signal for how much two legs overlap.
 *
 * We approximate each leg by the *straight segment* between its two caches and
 * rasterise that segment onto a fixed-cell grid (same equirectangular trick as
 * the post-order `OverlapGrid` in apps/api). Real OSRM leg geometry would be
 * more accurate but is unavailable without ~N² extra `/route` calls — and the
 * proxy's one weakness (collinear caches on a single street rasterise to the
 * same cells) is exactly the retracing signal we want to penalise in the
 * *ordering*. Realised-geometry accuracy is handled downstream by the existing
 * loop-aware leg picker, which is left untouched.
 *
 * Everything here is pure and structured-clone-serialisable so it can run
 * inside the planner worker pool (ADR-0014).
 */

/** Origin-relative cell coordinate bias + stride for packing (ix, iy) into one
 *  exact integer. Cells are projected relative to the first coordinate, so
 *  ix/iy stay within a few thousand of zero for a single tour; the bias keeps
 *  negatives non-negative and the stride keeps the product < 2^53 (exact). */
const CELL_BIAS = 1 << 20;
const CELL_STRIDE = 1 << 21;

/** Pack an integer cell coordinate into a single exact-integer id. */
function packCell(ix: number, iy: number): number {
  return (iy + CELL_BIAS) * CELL_STRIDE + (ix + CELL_BIAS);
}

/**
 * Flat, serialisable map from each unordered cache pair to the set of grid
 * cells its straight-line proxy segment passes through. Index pairs with
 * `pairIndex(i, j)`; a pair's cells live in `cells[offsets[p] .. offsets[p+1])`.
 */
export interface LegCellMap {
  /** Number of caches the map was built for. */
  n: number;
  /** Grid cell size in meters (also the per-cell overlap weight). */
  gridMeters: number;
  /** Prefix offsets into `cells`, length `numPairs + 1`. */
  offsets: Int32Array;
  /** Packed cell ids for every pair, concatenated. */
  cells: Float64Array;
}

/** Number of unordered pairs for `n` caches. */
function pairCount(n: number): number {
  return (n * (n - 1)) / 2;
}

/**
 * Index of the unordered pair {a, b} in the flat pair arrays. Order-independent
 * (normalises so i < j). Caller passes 0 ≤ a, b < n with a ≠ b.
 */
export function pairIndex(n: number, a: number, b: number): number {
  const i = a < b ? a : b;
  const j = a < b ? b : a;
  // Rows laid out triangularly: row i contributes (n - i - 1) entries.
  return i * n - (i * (i + 1)) / 2 + (j - i - 1);
}

/**
 * Rasterise every straight cache-to-cache segment onto a grid and return the
 * flat `LegCellMap`. `coords` are `[lng, lat]` in the same index order as the
 * distance matrix the solver uses.
 */
export function buildLegCellMap(
  coords: readonly (readonly [number, number])[],
  gridMeters: number,
): LegCellMap {
  const n = coords.length;
  const grid = gridMeters > 0 ? gridMeters : 25;
  if (n < 2) {
    return { n, gridMeters: grid, offsets: new Int32Array([0]), cells: new Float64Array(0) };
  }

  // Equirectangular projection relative to the first coordinate (matches
  // OverlapGrid): 1° lat ≈ 111_320 m; 1° lng ≈ 111_320 m × cos(originLat).
  const originLng = coords[0]![0];
  const originLat = coords[0]![1];
  const cosOriginLat = Math.cos((originLat * Math.PI) / 180);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    px[i] = (coords[i]![0] - originLng) * 111_320 * cosOriginLat;
    py[i] = (coords[i]![1] - originLat) * 111_320;
  }

  const numPairs = pairCount(n);
  const offsets = new Int32Array(numPairs + 1);
  // First pass would be needed to size `cells` exactly; instead collect into a
  // growable array, then copy. Pair count is ≤ ~1225 for N=50 and each leg is a
  // few-km segment ⇒ tens of cells; total stays in the tens-of-KB range.
  const flat: number[] = [];
  let p = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      offsets[p] = flat.length;
      rasteriseSegment(px[i]!, py[i]!, px[j]!, py[j]!, grid, flat);
      p += 1;
    }
  }
  offsets[numPairs] = flat.length;
  return { n, gridMeters: grid, offsets, cells: Float64Array.from(flat) };
}

/**
 * Walk the straight segment (ax, ay)→(bx, by) in local meters, stepping fine
 * enough (½ cell) that no crossed cell is skipped, and append each DISTINCT
 * packed cell id to `out`. Consecutive duplicates are dropped; a segment can
 * still revisit a cell on a diagonal but that only mildly over-weights the
 * proxy and is harmless as a monotone penalty.
 */
function rasteriseSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  gridMeters: number,
  out: number[],
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil((len / gridMeters) * 2));
  let lastId = Number.NaN;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = ax + dx * t;
    const y = ay + dy * t;
    const ix = Math.round(x / gridMeters);
    const iy = Math.round(y / gridMeters);
    const id = packCell(ix, iy);
    if (id !== lastId) {
      out.push(id);
      lastId = id;
    }
  }
}

/**
 * Running multiset of grid cells covered by the legs currently in a tour.
 * `retrace = gridMeters · Σ_cells max(0, coverCount − 1)` — every cell covered
 * by two or more legs contributes its excess coverage. Order-independent;
 * `previewDelta` evaluates a candidate move without mutating, so 2-opt / Or-opt
 * can score moves cheaply (work proportional to the changed legs' cells, not N).
 */
export class OverlapAccumulator {
  private readonly counts = new Map<number, number>();
  private readonly map: LegCellMap;
  private readonly cellSizeMeters: number;
  /** Running Σ max(0, count − 1) across all cells (excess coverage in cells). */
  private excessCells = 0;
  /** Scratch reused by previewDelta to avoid per-call allocation. */
  private readonly scratch = new Map<number, number>();

  constructor(map: LegCellMap) {
    this.map = map;
    this.cellSizeMeters = map.gridMeters;
  }

  /** Iterate the packed cell ids of the leg between cache indices a and b. */
  private legCells(a: number, b: number): { start: number; end: number } {
    const p = pairIndex(this.map.n, a, b);
    return { start: this.map.offsets[p]!, end: this.map.offsets[p + 1]! };
  }

  /** Add the leg (a, b) to the tour. */
  add(a: number, b: number): void {
    if (a === b) return;
    const { start, end } = this.legCells(a, b);
    for (let k = start; k < end; k += 1) {
      const cell = this.map.cells[k]!;
      const old = this.counts.get(cell) ?? 0;
      this.counts.set(cell, old + 1);
      if (old >= 1) this.excessCells += 1;
    }
  }

  /** Remove the leg (a, b) from the tour. */
  remove(a: number, b: number): void {
    if (a === b) return;
    const { start, end } = this.legCells(a, b);
    for (let k = start; k < end; k += 1) {
      const cell = this.map.cells[k]!;
      const old = this.counts.get(cell) ?? 0;
      if (old <= 1) this.counts.delete(cell);
      else this.counts.set(cell, old - 1);
      if (old >= 2) this.excessCells -= 1;
    }
  }

  /** Current retrace penalty in meters. */
  penalty(): number {
    return this.excessCells * this.cellSizeMeters;
  }

  /**
   * Change in retrace penalty (meters) if `removed` legs left the tour and
   * `added` legs joined it, WITHOUT mutating. Each entry is an [a, b] cache
   * index pair. Coincident edges across the lists net out correctly.
   */
  previewDelta(
    removed: readonly (readonly [number, number])[],
    added: readonly (readonly [number, number])[],
  ): number {
    const touched = this.scratch;
    touched.clear();
    for (const [a, b] of removed) {
      if (a === b) continue;
      const { start, end } = this.legCells(a, b);
      for (let k = start; k < end; k += 1) {
        const cell = this.map.cells[k]!;
        touched.set(cell, (touched.get(cell) ?? 0) - 1);
      }
    }
    for (const [a, b] of added) {
      if (a === b) continue;
      const { start, end } = this.legCells(a, b);
      for (let k = start; k < end; k += 1) {
        const cell = this.map.cells[k]!;
        touched.set(cell, (touched.get(cell) ?? 0) + 1);
      }
    }
    let deltaExcess = 0;
    for (const [cell, net] of touched) {
      if (net === 0) continue;
      const old = this.counts.get(cell) ?? 0;
      const next = old + net;
      deltaExcess += Math.max(0, next - 1) - Math.max(0, old - 1);
    }
    return deltaExcess * this.cellSizeMeters;
  }
}
