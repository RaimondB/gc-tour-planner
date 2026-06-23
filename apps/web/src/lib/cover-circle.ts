// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** A search circle: center `[lng, lat]` and radius in metres. */
export interface SearchCircle {
  center: [number, number];
  radiusM: number;
}

const EARTH_R = 6_371_000;
/** Floor so a recentred circle around a tight tour isn't a dot. */
const MIN_RADIUS_M = 500;
const MAX_RADIUS_M = 50_000;

function haversine(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Compute the search circle needed to cover `coords`, or `null` when the current
 * circle already does (so the caller can skip a no-op state change).
 *
 * Used to keep the search circle (which bounds the caches query + the visible
 * RadiusLayer) around the currently-relevant set — a focused cluster, added
 * Adventure-Lab stages, or an opened saved tour — so those caches always load
 * and the circle visibly encloses them.
 *
 *  - `recenter: false` (cluster / AL pull-in): keep the center, only **grow** the
 *    radius enough to enclose `coords`. Never shrinks. Returns null if they
 *    already fit.
 *  - `recenter: true` (open a saved tour): move the center to the coords' bbox
 *    center and size the radius to enclose them (may shrink — a saved tour in a
 *    far, smaller area reframes the whole circle there). Returns null only when
 *    the circle is already centered + sized within tolerance.
 *
 * Radius is padded by `marginPct` (default 12%) and clamped to [500 m, 50 km].
 */
export function coverCircle(
  coords: ReadonlyArray<readonly [number, number]>,
  current: SearchCircle,
  opts: { recenter: boolean; marginPct?: number },
): SearchCircle | null {
  if (coords.length === 0) return null;

  let minLng = coords[0]![0];
  let maxLng = minLng;
  let minLat = coords[0]![1];
  let maxLat = minLat;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const bboxCenter: [number, number] = [
    (minLng + maxLng) / 2,
    (minLat + maxLat) / 2,
  ];
  const center: [number, number] = opts.recenter ? bboxCenter : current.center;

  let maxDist = 0;
  for (const c of coords) maxDist = Math.max(maxDist, haversine(center, c));
  const margin = opts.marginPct ?? 0.12;
  let radiusM = Math.min(
    MAX_RADIUS_M,
    Math.max(MIN_RADIUS_M, Math.ceil(maxDist * (1 + margin))),
  );

  if (!opts.recenter) {
    // Grow-only: keep the user's circle if it's already big enough.
    radiusM = Math.max(radiusM, current.radiusM);
    const grew =
      radiusM > current.radiusM + Math.max(50, current.radiusM * 0.02);
    return grew ? { center, radiusM } : null;
  }

  // Recenter: act only if the center really moved or the radius differs enough.
  const centerMoved = haversine(current.center, center) > 25;
  const radiusDiffers =
    Math.abs(radiusM - current.radiusM) > Math.max(50, current.radiusM * 0.05);
  return centerMoved || radiusDiffers ? { center, radiusM } : null;
}
