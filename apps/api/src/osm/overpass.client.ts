// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Geo, Landuse } from "@gctp/shared";
import { classifyLanduse } from "./landuse-classify.js";

/**
 * Fetched polygon plus its OSM identity. The repository persists `osmWayId`
 * so re-fetches of the same way overwrite (via the (area_hash, osm_way_id)
 * unique index) rather than duplicate.
 */
export interface FetchedLanduse {
  osmWayId: number;
  kind: Landuse.LanduseKind;
  polygon: Geo.GeoJsonPolygon;
}

export const OVERPASS_CLIENT = Symbol.for("@gctp/api/osm/OVERPASS_CLIENT");

export interface OverpassClient {
  fetchLanduse(bbox: Geo.BoundingBox): Promise<FetchedLanduse[]>;
}

interface OverpassWay {
  type: "way";
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassWay[];
}

/**
 * Real Overpass client. Synchronous fetch on every cache miss — async
 * refresh via BullMQ lands in M4 ([docs/REQUIREMENTS.md §Roadmap]). For now
 * the 30-day cache window plus a 60s request timeout is enough to stay
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
 * Closed-way Overpass query covering all canonical landuse kinds. We
 * intentionally skip relations (multipolygons) for MVP — covers ~80% of
 * useful landuse coverage at a tenth of the parsing complexity. Add
 * relation handling when a real user gap surfaces.
 */
export function buildLanduseQuery(bbox: Geo.BoundingBox): string {
  const b = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  return `[out:json][timeout:60];
(
  way["landuse"~"^(forest|park|residential|farmland|industrial|meadow|heath|scrub)$"](${b});
  way["natural"~"^(wood|water|wetland|heath|scrub)$"](${b});
  way["leisure"~"^(park|nature_reserve)$"](${b});
);
out tags geom;`;
}

export function normalizeOverpassResponse(
  json: OverpassResponse,
): FetchedLanduse[] {
  const out: FetchedLanduse[] = [];
  for (const el of json.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const tags = el.tags ?? {};
    const kind = classifyLanduse(tags);
    if (!kind) continue;

    // Close the ring if Overpass didn't.
    const coords: [number, number][] = el.geometry.map((g) => [g.lon, g.lat]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (!first || !last) continue;
    if (first[0] !== last[0] || first[1] !== last[1])
      coords.push([first[0], first[1]]);
    if (coords.length < 4) continue;

    out.push({
      osmWayId: el.id,
      kind,
      polygon: { type: "Polygon", coordinates: [coords] },
    });
  }
  return out;
}
