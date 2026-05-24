// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Geo, Routing } from "@gctp/shared";

export interface OsrmLeg {
  meters: number;
  seconds: number;
  geometry: Geo.GeoJsonLineString;
}

export interface OsrmMatrixEntry {
  meters: number;
  seconds: number;
}

export interface OsrmClient {
  /** Foot-route between two coordinate pairs. Returns null on disconnected pair. */
  route(
    from: [number, number],
    to: [number, number],
    profile: Routing.RoutingProfile,
  ): Promise<OsrmLeg | null>;
  /**
   * OD matrix in one call. Returns an N×N grid of { meters, seconds } or null
   * per cell (disconnected). Diagonals are { meters: 0, seconds: 0 }.
   */
  table(
    coords: readonly [number, number][],
    profile: Routing.RoutingProfile,
  ): Promise<(OsrmMatrixEntry | null)[][]>;
}

export const OSRM_CLIENT = Symbol.for("@gctp/api/routing/OSRM_CLIENT");

interface OsrmRouteResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: Geo.GeoJsonLineString | { type: string; coordinates: unknown };
  }>;
}

interface OsrmTableResponse {
  code: string;
  durations?: (number | null)[][];
  distances?: (number | null)[][];
}

/**
 * Thin OSRM HTTP client. Talks to `OSRM_URL` (compose default
 * http://osrm:5000). All routes use the contracted-graph algorithm; the
 * container's bootstrap.sh runs `osrm-contract`.
 *
 * NOTE: OSRM may return `code != "Ok"` for disconnected pairs (NoRoute) —
 * we surface that as `null` rather than throwing, since the matrix needs to
 * keep going even if one pair fails.
 */
@Injectable()
export class HttpOsrmClient implements OsrmClient {
  private readonly logger = new Logger(HttpOsrmClient.name);
  private readonly base: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.base = (config.get<string>("OSRM_URL") ?? "http://osrm:5000").replace(
      /\/+$/,
      "",
    );
  }

  async route(
    from: [number, number],
    to: [number, number],
    profile: Routing.RoutingProfile,
  ): Promise<OsrmLeg | null> {
    const url =
      `${this.base}/route/v1/${profile}/${fmt(from)};${fmt(to)}` +
      `?overview=full&geometries=geojson&steps=false&annotations=false`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OSRM /route ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as OsrmRouteResponse;
    if (json.code !== "Ok" || !json.routes || json.routes.length === 0)
      return null;
    const r = json.routes[0]!;
    if (r.geometry.type !== "LineString") return null;
    return {
      meters: r.distance,
      seconds: r.duration,
      geometry: r.geometry as Geo.GeoJsonLineString,
    };
  }

  async table(
    coords: readonly [number, number][],
    profile: Routing.RoutingProfile,
  ): Promise<(OsrmMatrixEntry | null)[][]> {
    if (coords.length === 0) return [];
    if (coords.length === 1) return [[{ meters: 0, seconds: 0 }]];
    const url =
      `${this.base}/table/v1/${profile}/${coords.map(fmt).join(";")}` +
      `?annotations=distance,duration`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OSRM /table ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as OsrmTableResponse;
    if (json.code !== "Ok" || !json.durations || !json.distances) {
      throw new Error(`OSRM /table returned code=${json.code}`);
    }
    const out: (OsrmMatrixEntry | null)[][] = [];
    for (let i = 0; i < coords.length; i += 1) {
      const row: (OsrmMatrixEntry | null)[] = [];
      for (let j = 0; j < coords.length; j += 1) {
        const d = json.distances[i]?.[j];
        const t = json.durations[i]?.[j];
        if (d === null || d === undefined || t === null || t === undefined) {
          row.push(null);
        } else {
          row.push({ meters: d, seconds: t });
        }
      }
      out.push(row);
    }
    return out;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      return await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "gc-tour-planner/0.0 (+https://github.com/RaimondB/gc-tour-planner)",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function fmt(p: [number, number]): string {
  return `${p[0]},${p[1]}`;
}
