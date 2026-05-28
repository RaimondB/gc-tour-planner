// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CacheDTO } from "@gctp/shared/caches";
import type { PlanResult } from "@gctp/shared/tours";

/**
 * Two GPX flavours, both consumable by a Garmin device:
 *
 *   * **Track** (`planToGpxTrack`) — emits `<trk>` with every coordinate
 *     from the planner's OSRM polyline. The Garmin treats it as a
 *     pre-recorded path; it follows the line literally and doesn't
 *     re-route if you stray. Use this when you trust the planner's
 *     route more than the device's onboard map (typical: dense urban
 *     foot routing where OSM-derived footways aren't all on the
 *     Garmin's CN Europe basemap).
 *
 *   * **Route** (`planToGpxRoute`) — emits `<rte>` with one `<rtept>`
 *     per visit waypoint (parking → cache 1 → cache 2 → … → cache N →
 *     parking back home). The Garmin computes the actual leg geometry
 *     via its onboard routing engine and recomputes if you deviate.
 *     Use this when the device's basemap is good and you want
 *     turn-by-turn navigation.
 *
 * Both include a `<wpt>` per cache so the device can save the caches
 * as standalone POIs (typed `<sym>Geocache</sym>` — the device shows a
 * "treasure chest" or yellow flag depending on firmware).
 *
 * Cache id → details lookup is by `caches` prop; ids missing from the
 * lookup are emitted with a placeholder name so the resulting GPX
 * still parses — the device will just show the empty entry.
 */

const PROLOG = `<?xml version="1.0" encoding="UTF-8"?>`;
const GPX_ATTRS =
  `version="1.1" creator="gc-tour-planner ` +
  `(https://github.com/RaimondB/gc-tour-planner)" ` +
  `xmlns="http://www.topografix.com/GPX/1/1" ` +
  `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
  `xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ` +
  `http://www.topografix.com/GPX/1/1/gpx.xsd"`;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return c;
    }
  });
}

interface GpxStop {
  lng: number;
  lat: number;
  name: string;
  desc?: string;
  sym?: string;
}

function buildStops(
  result: PlanResult,
  cacheById: ReadonlyMap<number, CacheDTO>,
): GpxStop[] {
  const stops: GpxStop[] = [];
  const parkingPoint = result.parking.point.coordinates;
  stops.push({
    lng: parkingPoint[0]!,
    lat: parkingPoint[1]!,
    name: "Parking",
    desc: result.parking.reason,
    sym: "Parking Area",
  });
  for (let i = 0; i < result.orderedCacheIds.length; i += 1) {
    const id = result.orderedCacheIds[i]!;
    const c = cacheById.get(id);
    const coords = c?.location.coordinates;
    if (!coords) continue;
    stops.push({
      lng: coords[0]!,
      lat: coords[1]!,
      // Numbered + code + name keeps the device's truncated label readable:
      // "1 GC12345 — Hidden in the park".
      name: `${i + 1} ${c?.code ?? `cache-${id}`}${c?.name ? ` — ${c.name}` : ""}`,
      sym: "Geocache",
    });
  }
  return stops;
}

function emitWaypoints(stops: readonly GpxStop[]): string {
  return stops
    .map((s) => {
      const inner = [`<name>${escapeXml(s.name)}</name>`];
      if (s.desc) inner.push(`<desc>${escapeXml(s.desc)}</desc>`);
      if (s.sym) inner.push(`<sym>${escapeXml(s.sym)}</sym>`);
      return `<wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}">${inner.join("")}</wpt>`;
    })
    .join("\n");
}

function buildHeader(name: string): string {
  const now = new Date().toISOString();
  return `<metadata><name>${escapeXml(name)}</name><time>${now}</time></metadata>`;
}

/**
 * Wrap the planner's OSRM polyline in a GPX `<trk>` so the Garmin
 * follows the exact line we drew on the map.
 */
export function planToGpxTrack(
  result: PlanResult,
  caches: readonly CacheDTO[] | undefined,
  name = "gc-tour-planner — track",
): string {
  const cacheById = new Map<number, CacheDTO>();
  for (const c of caches ?? []) cacheById.set(c.id, c);
  const stops = buildStops(result, cacheById);
  const trkpts = result.polyline.coordinates
    .map(
      ([lng, lat]) =>
        `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`,
    )
    .join("");
  return [
    PROLOG,
    `<gpx ${GPX_ATTRS}>`,
    buildHeader(name),
    emitWaypoints(stops),
    `<trk><name>${escapeXml(name)}</name><trkseg>${trkpts}</trkseg></trk>`,
    `</gpx>`,
  ].join("\n");
}

/**
 * Emit a GPX `<rte>` of routepoints — parking, then each cache in
 * visit order, then back to parking. The Garmin's onboard router
 * picks the leg geometry between each pair, so straying off the line
 * is fine: the device recomputes.
 */
export function planToGpxRoute(
  result: PlanResult,
  caches: readonly CacheDTO[] | undefined,
  name = "gc-tour-planner — route",
): string {
  const cacheById = new Map<number, CacheDTO>();
  for (const c of caches ?? []) cacheById.set(c.id, c);
  const stops = buildStops(result, cacheById);
  // Close the loop — the planner's polyline ends back at parking, but
  // the cache list doesn't, so we explicitly tack on the parking
  // rtept again at the end. Garmin handles a doubled endpoint cleanly.
  const closeLoop = stops.length > 1 ? [stops[0]!] : [];
  const all = [...stops, ...closeLoop];
  const rtepts = all
    .map((s) => {
      const inner = [`<name>${escapeXml(s.name)}</name>`];
      if (s.sym) inner.push(`<sym>${escapeXml(s.sym)}</sym>`);
      return `<rtept lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}">${inner.join("")}</rtept>`;
    })
    .join("");
  return [
    PROLOG,
    `<gpx ${GPX_ATTRS}>`,
    buildHeader(name),
    emitWaypoints(stops),
    `<rte><name>${escapeXml(name)}</name>${rtepts}</rte>`,
    `</gpx>`,
  ].join("\n");
}
