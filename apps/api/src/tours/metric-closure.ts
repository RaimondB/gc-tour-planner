// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Metric closure of a walking-distance matrix over the `≤ maxLinkMeters` graph.
 *
 * Why this exists: the connected-component pre-filter (`largestConnected
 * component`) guarantees the candidate set is *connected*, not that every
 * *direct* pair is routable. Two reps in the same `≤ maxLinkMeters` component can
 * still have a `null` direct leg (no OSRM foot route between them, only via
 * intermediates). A tour that places such a pair consecutively then carries a
 * `null` leg → the marginal trim's loop length reads `∞` and it can mildly
 * over-trim (the disconnected-over-trim failure mode this fixes).
 *
 * The cure: compute the all-pairs shortest path over the `≤ maxLinkMeters` graph
 * and fill each `null` direct leg with that through-component distance, so the
 * solver and the trim always work on a fully-finite matrix. Because the kept set
 * is connected over exactly this graph, every `null` pair in the component gets a
 * finite fill; a pair that is still unreachable (one-directional gap) is left
 * `null` and the downstream wire-boundary sanitisation handles it as before.
 *
 * Only `null`/unroutable direct legs are filled. A *finite* direct leg — even one
 * longer than `maxLinkMeters` — is a real OSRM route and is kept untouched; the
 * cap only restricts which legs may serve as stepping stones in the closure.
 *
 * Directed: `meters[i][j]` is the i→j leg and may differ from `meters[j][i]`;
 * shortest paths are computed per direction. When a `seconds` matrix is supplied,
 * a filled leg's seconds are carried along the same shortest-metre path so the
 * metres and seconds of a synthesised leg stay coherent.
 *
 * Pure + unit-testable. `O(n³)` Floyd–Warshall; `n ≤ MAX_LOOP_CACHES` (50), so a
 * handful of thousand iterations per plan — negligible.
 */

export interface MetricClosureResult {
  /** Meters matrix with `null` direct legs filled where a `≤ maxLink` path exists. */
  meters: (number | null)[][];
  /** Seconds matrix filled in lock-step, or `null` when no seconds were supplied. */
  seconds: (number | null)[][] | null;
  /** How many off-diagonal `null` legs were filled (for logging). */
  filledLegs: number;
}

export function metricClosure(
  meters: readonly (readonly (number | null)[])[],
  maxLinkMeters: number,
  seconds?: readonly (readonly (number | null)[])[] | null,
): MetricClosureResult {
  const n = meters.length;
  const INF = Number.POSITIVE_INFINITY;
  const withSeconds = seconds != null;

  // Shortest-path matrices over the ≤maxLink graph. Diagonal 0; an off-diagonal
  // entry seeds a graph edge only when the direct leg is finite AND within the
  // linking cap (a longer real leg is kept on output but never a stepping stone).
  const dist: number[][] = [];
  const sec: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const dRow: number[] = [];
    const sRow: number[] = [];
    for (let j = 0; j < n; j += 1) {
      if (i === j) {
        dRow.push(0);
        sRow.push(0);
        continue;
      }
      const m = meters[i]?.[j];
      const isEdge = m != null && Number.isFinite(m) && m <= maxLinkMeters;
      dRow.push(isEdge ? (m as number) : INF);
      if (!isEdge) {
        sRow.push(INF);
      } else {
        const s = withSeconds ? seconds[i]?.[j] : null;
        sRow.push(s != null && Number.isFinite(s) ? s : 0);
      }
    }
    dist.push(dRow);
    sec.push(sRow);
  }

  // Floyd–Warshall. Carry seconds along the shortest-metre path so a filled
  // leg's seconds correspond to the metres it reports.
  for (let k = 0; k < n; k += 1) {
    const distK = dist[k]!;
    const secK = sec[k]!;
    for (let i = 0; i < n; i += 1) {
      const distI = dist[i]!;
      const dik = distI[k]!;
      if (dik === INF) continue;
      const secIk = sec[i]![k]!;
      for (let j = 0; j < n; j += 1) {
        const cand = dik + distK[j]!;
        if (cand < distI[j]!) {
          distI[j] = cand;
          sec[i]![j] = secIk + secK[j]!;
        }
      }
    }
  }

  // Keep every finite direct leg as-is; fill only the null/unroutable ones with
  // the through-component distance (left null when no ≤maxLink path exists).
  let filledLegs = 0;
  const outMeters: (number | null)[][] = [];
  const outSeconds: (number | null)[][] | null = withSeconds ? [] : null;
  for (let i = 0; i < n; i += 1) {
    const mRow: (number | null)[] = [];
    const sRow: (number | null)[] = [];
    for (let j = 0; j < n; j += 1) {
      if (i === j) {
        mRow.push(0);
        sRow.push(0);
        continue;
      }
      const orig = meters[i]?.[j];
      if (orig != null && Number.isFinite(orig)) {
        mRow.push(orig);
        sRow.push(withSeconds ? (seconds[i]?.[j] ?? null) : null);
      } else if (Number.isFinite(dist[i]![j]!)) {
        mRow.push(dist[i]![j]!);
        sRow.push(
          withSeconds && Number.isFinite(sec[i]![j]!) ? sec[i]![j]! : null,
        );
        filledLegs += 1;
      } else {
        mRow.push(null);
        sRow.push(null);
      }
    }
    outMeters.push(mRow);
    if (outSeconds) outSeconds.push(sRow);
  }

  return { meters: outMeters, seconds: outSeconds, filledLegs };
}
