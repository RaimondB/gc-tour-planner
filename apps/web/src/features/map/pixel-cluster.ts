// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pixel-proximity clustering shared by the planned-tour stops (TourLayer) and
 * the Adventure Lab stages on the caches map (CachesLayer). Points whose markers
 * overlap on screen at the current zoom merge into one group; they separate as
 * the user zooms in. Because it's pixel-based (the caller passes `map.project`)
 * it's recomputed on zoom — truly-coincident points stay merged at every zoom,
 * while merely-near ones pop apart. Pure + dependency-free for testing.
 */
export interface ClusterPoint<T> {
  lng: number;
  lat: number;
  item: T;
}

export interface PixelCluster<T> {
  /** The points in this group, in input order. A singleton group has length 1. */
  members: T[];
  /** Centroid of the members (lng, lat) — where a merged marker is drawn. */
  center: [number, number];
}

/** Centre-to-centre screen distance under which two ~12px markers overlap. */
export const OVERLAP_PX = 20;

/**
 * Greedy single-pass clustering: anchor on each unused point and absorb every
 * later point within `thresholdPx` of the anchor. Returns one {@link PixelCluster}
 * per group (singletons included), so the caller can split singletons (render
 * individually) from merged groups (render a collapsed marker).
 */
export function clusterByPixelProximity<T>(
  points: readonly ClusterPoint<T>[],
  project: (lngLat: [number, number]) => { x: number; y: number },
  thresholdPx: number = OVERLAP_PX,
): PixelCluster<T>[] {
  const px = points.map((p) => project([p.lng, p.lat]));
  const used = new Array<boolean>(points.length).fill(false);
  const out: PixelCluster<T>[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const members: T[] = [points[i]!.item];
    let sumLng = points[i]!.lng;
    let sumLat = points[i]!.lat;
    for (let j = i + 1; j < points.length; j += 1) {
      if (used[j]) continue;
      if (Math.hypot(px[i]!.x - px[j]!.x, px[i]!.y - px[j]!.y) <= thresholdPx) {
        used[j] = true;
        members.push(points[j]!.item);
        sumLng += points[j]!.lng;
        sumLat += points[j]!.lat;
      }
    }
    out.push({
      members,
      center: [sumLng / members.length, sumLat / members.length],
    });
  }
  return out;
}
