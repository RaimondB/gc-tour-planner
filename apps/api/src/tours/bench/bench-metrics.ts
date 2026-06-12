// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared, pure helpers for the planner benchmark tools (loop-objective-bench,
// planner-sweep). No NestJS, no I/O — just metrics + stats so the harnesses
// measure the same things the same way.

export const num = (key: string, fallback: number): number => {
  const v = Number.parseFloat(process.env[key] ?? "");
  return Number.isFinite(v) ? v : fallback;
};

/**
 * Realised retrace of a route polyline (meters): collapse the coordinate stream
 * into the sequence of grid cells it enters, count how many times each cell is
 * entered, and sum the excess (entries − 1) × cell size. A clean loop enters
 * each cell once (≈0); walking a street twice enters its cells twice. Measured
 * on the ACTUAL OSRM geometry, independent of the solver's straight-line proxy.
 */
export function realisedRetraceMeters(
  geometry: { coordinates: readonly (readonly number[])[] },
  gridMeters: number,
): number {
  const coords = geometry.coordinates;
  if (coords.length < 2) return 0;
  const originLng = coords[0]![0]!;
  const originLat = coords[0]![1]!;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const visits = new Map<string, number>();
  let lastKey = "";
  for (const c of coords) {
    const mLng = (c[0]! - originLng) * 111_320 * cosLat;
    const mLat = (c[1]! - originLat) * 111_320;
    const key = `${Math.round(mLng / gridMeters)}:${Math.round(mLat / gridMeters)}`;
    if (key === lastKey) continue; // same cell, still one visit
    visits.set(key, (visits.get(key) ?? 0) + 1);
    lastKey = key;
  }
  let excess = 0;
  for (const n of visits.values()) excess += Math.max(0, n - 1);
  return excess * gridMeters;
}

export const arrEq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Population standard deviation. */
export const stdev = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export const minOf = (xs: readonly number[]): number =>
  xs.length ? Math.min(...xs) : 0;

export const maxOf = (xs: readonly number[]): number =>
  xs.length ? Math.max(...xs) : 0;

/** Fraction of values satisfying the predicate, as a percentage. */
export const pctWhere = (
  xs: readonly number[],
  pred: (x: number) => boolean,
): number => (xs.length ? (xs.filter(pred).length / xs.length) * 100 : 0);

/**
 * Count occurrences of each integer value → `{ value: count }`, ascending by
 * value. Feeds a histogram / Pareto chart of "how many clusters have N caches".
 */
export const histogram = (xs: readonly number[]): Record<number, number> => {
  const h: Record<number, number> = {};
  for (const x of xs) {
    const k = Math.round(x);
    h[k] = (h[k] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(h).sort((a, b) => Number(a[0]) - Number(b[0])),
  );
};

/** Jaccard similarity of two id sets — used to dedup overlapping clusters. */
export function jaccard(a: readonly number[], b: readonly number[]): number {
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter += 1;
  const union = sa.size + b.length - inter;
  return union === 0 ? 0 : inter / union;
}
