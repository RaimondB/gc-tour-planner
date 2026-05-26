// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Geo, Landuse } from "@gctp/shared";
import { classifyLanduse } from "./landuse-classify.js";

/**
 * Fetched polygon plus its OSM identity. The repository persists `osmSource`
 * so re-fetches of the same way/relation overwrite (via the
 * (area_hash, osm_source) unique index) rather than duplicate.
 *
 * - osmSource = 'way:<id>' for a standalone closed way
 * - osmSource = 'rel:<id>:<ringIndex>' for one outer ring of a multipolygon
 */
export interface FetchedLanduse {
  osmSource: string;
  kind: Landuse.LanduseKind;
  polygon: Geo.GeoJsonPolygon;
}

export const OVERPASS_CLIENT = Symbol.for("@gctp/api/osm/OVERPASS_CLIENT");

export interface OverpassClient {
  fetchLanduse(bbox: Geo.BoundingBox): Promise<FetchedLanduse[]>;
}

interface OverpassNode {
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  geometry?: OverpassNode[];
  tags?: Record<string, string>;
}

interface OverpassRelationMember {
  type: string;
  ref: number;
  role?: string;
  geometry?: OverpassNode[];
}

interface OverpassRelation {
  type: "relation";
  id: number;
  members?: OverpassRelationMember[];
  tags?: Record<string, string>;
}

type OverpassElement = OverpassWay | OverpassRelation;

interface OverpassResponse {
  elements: OverpassElement[];
}

/**
 * Real Overpass client. Synchronous fetch on every cache miss — async
 * refresh via BullMQ lands in M4 (see docs/requirements/roadmap.md). The
 * 30-day cache window plus a 60s request timeout is enough to stay
 * comfortably within public Overpass fair-use limits.
 */
@Injectable()
export class HttpOverpassClient implements OverpassClient {
  private readonly logger = new Logger(HttpOverpassClient.name);
  private readonly endpoint: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.endpoint =
      config.get<string>("OVERPASS_URL") ??
      "https://overpass-api.de/api/interpreter";
  }

  async fetchLanduse(bbox: Geo.BoundingBox): Promise<FetchedLanduse[]> {
    const query = buildLanduseQuery(bbox);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "gc-tour-planner/0.0 (+https://github.com/RaimondB/gc-tour-planner)",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Overpass ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as OverpassResponse;
    return normalizeOverpassResponse(json);
  }
}

/**
 * Query both closed ways AND multipolygon relations. Output uses `out geom;`
 * (default `body` modifier) so the relation member list AND each member's
 * inline geometry both come back in one roundtrip. The earlier `out tags geom;`
 * silently dropped relation members — they were fetched but never assembled.
 */
export function buildLanduseQuery(bbox: Geo.BoundingBox): string {
  const b = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  return `[out:json][timeout:60];
(
  way["landuse"~"^(forest|park|residential|farmland|industrial|meadow|heath|scrub)$"](${b});
  way["natural"~"^(wood|water|wetland|heath|scrub)$"](${b});
  way["leisure"~"^(park|nature_reserve)$"](${b});
  relation["landuse"~"^(forest|park|residential|farmland|industrial|meadow|heath|scrub)$"](${b});
  relation["natural"~"^(wood|water|wetland|heath|scrub)$"](${b});
  relation["leisure"~"^(park|nature_reserve)$"](${b});
);
out geom;`;
}

export function normalizeOverpassResponse(
  json: OverpassResponse,
): FetchedLanduse[] {
  const out: FetchedLanduse[] = [];
  const seenSources = new Set<string>();

  for (const el of json.elements ?? []) {
    if (el.type === "way") {
      const ring = wayToRing(el);
      if (!ring) continue;
      const kind = classifyLanduse(el.tags ?? {});
      if (!kind) continue;
      pushUnique(out, seenSources, {
        osmSource: `way:${el.id}`,
        kind,
        polygon: { type: "Polygon", coordinates: [ring] },
      });
      continue;
    }
    if (el.type === "relation") {
      const kind = classifyLanduse(el.tags ?? {});
      if (!kind) continue;
      const rings = assembleOuterRings(el);
      rings.forEach((ring, i) => {
        pushUnique(out, seenSources, {
          osmSource: `rel:${el.id}:${i}`,
          kind,
          polygon: { type: "Polygon", coordinates: [ring] },
        });
      });
    }
  }
  return out;
}

function pushUnique(
  out: FetchedLanduse[],
  seen: Set<string>,
  f: FetchedLanduse,
): void {
  if (seen.has(f.osmSource)) return;
  seen.add(f.osmSource);
  out.push(f);
}

function wayToRing(way: OverpassWay): [number, number][] | null {
  const geom = way.geometry;
  if (!geom || geom.length < 3) return null;
  const ring = closeRing(geom.map<[number, number]>((g) => [g.lon, g.lat]));
  return ring.length >= 4 ? ring : null;
}

/**
 * Build outer rings from a multipolygon relation's outer member ways.
 *
 * Outer members may be a single closed way (common) or several open way
 * segments that share endpoints and need stitching. Both cases are handled.
 * Inner holes are NOT subtracted — multipolygons with cut-outs render as
 * solid fill. Acceptable visual fidelity for MVP; revisit if a real cache
 * sits inside a residential cut-out and is wrongly matched by
 * `contexts=residential`.
 */
function assembleOuterRings(rel: OverpassRelation): [number, number][][] {
  const segments = (rel.members ?? [])
    .filter(
      (m): m is OverpassRelationMember & { geometry: OverpassNode[] } =>
        m.type === "way" &&
        Array.isArray(m.geometry) &&
        m.geometry.length >= 2 &&
        (m.role === "outer" || m.role === "" || m.role === undefined),
    )
    .map((m) => m.geometry.map<[number, number]>((g) => [g.lon, g.lat]));

  const rings: [number, number][][] = [];

  // Fast path: any already-closed segment is its own outer ring.
  const open: [number, number][][] = [];
  for (const seg of segments) {
    if (seg.length >= 4 && coordEq(seg[0]!, seg[seg.length - 1]!)) {
      rings.push(seg);
    } else {
      open.push(seg);
    }
  }

  // Stitch open segments together — pick one as the seed, then repeatedly
  // attach another segment whose start (or reversed end) matches the ring's
  // current tail. Drops orphans whose endpoints don't connect.
  while (open.length > 0) {
    const ring: [number, number][] = open.shift()!.slice();
    let progress = true;
    while (progress && !isClosed(ring)) {
      progress = false;
      for (let i = 0; i < open.length; i += 1) {
        const seg = open[i]!;
        const end = ring[ring.length - 1]!;
        if (coordEq(end, seg[0]!)) {
          ring.push(...seg.slice(1));
          open.splice(i, 1);
          progress = true;
          break;
        }
        if (coordEq(end, seg[seg.length - 1]!)) {
          for (let j = seg.length - 2; j >= 0; j -= 1) ring.push(seg[j]!);
          open.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
    if (isClosed(ring) && ring.length >= 4) rings.push(ring);
  }

  return rings;
}

function closeRing(ring: [number, number][]): [number, number][] {
  if (ring.length === 0) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (!coordEq(first, last)) ring.push([first[0], first[1]]);
  return ring;
}

function isClosed(ring: [number, number][]): boolean {
  if (ring.length < 4) return false;
  return coordEq(ring[0]!, ring[ring.length - 1]!);
}

function coordEq(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
