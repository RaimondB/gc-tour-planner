// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** An Adventure Lab stage that's missing its `adventure_id` (FR-I17 backfill). */
export interface MissingIdStage {
  id: number;
  code: string;
  name: string;
  lng: number;
  lat: number;
}

/** One adventure's worth of stages to re-fetch from Lab2Gpx. */
export interface BackfillGroup {
  /** The adventure title (the `<title>` before `: S{n}` in each stage name). */
  title: string;
  /** Centre of the stages — where the Lab2Gpx re-fetch is anchored. */
  center: [number, number];
  /** Fetch radius (m): the farthest stage from the centre, plus a buffer. */
  radiusM: number;
  /** The member stages — matched against the fresh GPX by code, then coordinate. */
  members: MissingIdStage[];
}

/** Default extra radius (m) beyond the farthest stage, so the re-fetch isn't tight. */
const RADIUS_BUFFER_M = 600;
/** Floor so a single-spot adventure still fetches a usable area. */
const MIN_RADIUS_M = 800;

/** Strip the `: S{n} …` stage suffix to recover the shared adventure title. */
export function adventureTitleOf(name: string): string {
  return name.replace(/\s*:\s*S\d+\b.*$/i, "").trim();
}

/**
 * Round a coordinate to a ~1 m grid key for matching a stored stage against the
 * fresh Lab2Gpx fetch when their `code`s differ (the same stage imported under
 * two code schemes). Both sets come from Lab2Gpx, so 5 decimals align.
 */
export function coordKey(lng: number, lat: number): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

function haversineMeters(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Group missing-id stages into per-adventure re-fetch jobs, keyed on the shared
 * title. Each group gets a centre (the stage centroid) and a radius wide enough
 * to cover its spread, so one tight Lab2Gpx fetch re-fetches the whole adventure
 * and exposes its `goto/<guid>` deep-links. Pure + dependency-free for testing.
 */
export function groupStagesForBackfill(
  stages: readonly MissingIdStage[],
): BackfillGroup[] {
  const byTitle = new Map<string, MissingIdStage[]>();
  for (const s of stages) {
    const title = adventureTitleOf(s.name);
    if (!title) continue;
    const arr = byTitle.get(title);
    if (arr) arr.push(s);
    else byTitle.set(title, [s]);
  }

  const groups: BackfillGroup[] = [];
  for (const [title, members] of byTitle) {
    let sumLng = 0;
    let sumLat = 0;
    for (const m of members) {
      sumLng += m.lng;
      sumLat += m.lat;
    }
    const center: [number, number] = [
      sumLng / members.length,
      sumLat / members.length,
    ];
    let maxDist = 0;
    for (const m of members) {
      const d = haversineMeters(center, [m.lng, m.lat]);
      if (d > maxDist) maxDist = d;
    }
    groups.push({
      title,
      center,
      radiusM: Math.max(MIN_RADIUS_M, Math.ceil(maxDist) + RADIUS_BUFFER_M),
      members,
    });
  }
  return groups;
}
