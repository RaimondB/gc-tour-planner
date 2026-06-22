// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared pixel-proximity collapse for map markers (ADR-0035). Both the planned
 * tour's stops (TourLayer) and the Adventure-Lab stages on the caches map
 * (CachesLayer) collapse overlapping markers into one "stacked" node at low zoom
 * and separate them as the user zooms in. This module unifies the two
 * previously-duplicated implementations into one rule + label so a collapsed
 * group always looks and reads the same wherever it appears.
 *
 * It wraps {@link clusterByPixelProximity} (unchanged) and standardises:
 *   - the singleton / merged-group split, and
 *   - the collapsed-group label: a contiguous run of ordinals → "3–7", otherwise
 *     a plain count "×4" (and always "×N" when the items have no ordinal, e.g.
 *     AL stages).
 *
 * Pure + dependency-free (the caller passes `project`) so it's unit-testable.
 */
import {
  clusterByPixelProximity,
  OVERLAP_PX,
  type ClusterPoint,
} from "./pixel-cluster.js";

export interface CollapseGroup<T> {
  /** Centroid (lng, lat) where the stacked node is drawn. */
  center: [number, number];
  /** The merged items (length ≥ 2). */
  members: T[];
  /** Member count (== members.length; convenience for the count badge). */
  count: number;
  /** "3–7" for a contiguous ordinal run, else "×4". */
  label: string;
}

export interface CollapseResult<T> {
  /** Items that did not merge with any neighbour (render individually). */
  singles: T[];
  /** Merged groups (render one stacked node each). */
  groups: CollapseGroup<T>[];
}

export interface CollapseOptions<T> {
  /** Centre-to-centre screen distance under which two markers overlap. */
  thresholdPx?: number;
  /**
   * Optional ordinal accessor (e.g. a tour stop's visit order). When every
   * member of a group exposes a finite ordinal, a contiguous run renders as
   * "min–max"; otherwise (or when omitted) the label is a plain "×count".
   */
  order?: (item: T) => number | null | undefined;
}

/** Build the collapsed-group label from member ordinals (or a plain count). */
export function collapseLabel(
  orders: readonly (number | null | undefined)[],
): string {
  const finite = orders.filter(
    (o): o is number => typeof o === "number" && Number.isFinite(o),
  );
  if (finite.length !== orders.length || finite.length === 0) {
    return `×${orders.length}`;
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const contiguous = max - min + 1 === sorted.length;
  return contiguous ? `${min}–${max}` : `×${sorted.length}`;
}

/**
 * Partition `points` into individually-rendered singletons and merged groups
 * using pixel-proximity clustering. Groups carry a unified count/range label.
 */
export function collapseByProximity<T>(
  points: readonly ClusterPoint<T>[],
  project: (lngLat: [number, number]) => { x: number; y: number },
  opts: CollapseOptions<T> = {},
): CollapseResult<T> {
  const clusters = clusterByPixelProximity(
    points,
    project,
    opts.thresholdPx ?? OVERLAP_PX,
  );
  const singles: T[] = [];
  const groups: CollapseGroup<T>[] = [];
  for (const { members, center } of clusters) {
    if (members.length === 1) {
      singles.push(members[0]!);
      continue;
    }
    const orders = opts.order ? members.map(opts.order) : [];
    groups.push({
      center,
      members,
      count: members.length,
      label: opts.order ? collapseLabel(orders) : `×${members.length}`,
    });
  }
  return { singles, groups };
}
