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
   * Like `route`, but asks OSRM for up to `count` alternative geometries (the
   * primary plus alternatives). Always returns at least the primary when OSRM
   * succeeds; the empty array on disconnect. OSRM may return fewer than
   * `count` — alternatives only exist when the road network actually offers
   * distinct paths. Used by the loop-aware leg picker in Pass 2 to choose
   * non-overlapping polylines and stop the tour from retracing its steps.
   */
  routeAlternatives(
    from: [number, number],
    to: [number, number],
    profile: Routing.RoutingProfile,
    count: number,
  ): Promise<OsrmLeg[]>;
  /**
   * Route through a list of coordinates in order, returning the combined
   * geometry as one polyline. Used by the via-waypoint nudge to force OSRM
   * onto a parallel street when its built-in alternative finder doesn't
   * produce a usable variant. OSRM snaps each intermediate point to the
   * nearest walkable node — so a via offset 80 m perpendicular to the
   * straight line A→B effectively says "please route via the street on
   * that side if one exists; otherwise snap back."
   */
  routeMulti(
    coords: readonly [number, number][],
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
  /**
   * Snap a coordinate to the nearest routable node in the OSRM graph for the
   * given profile. Returns the snapped point or `null` if no road is found
   * within OSRM's default search radius. Used by the planner to keep parking
   * out of the middle of rivers — a raw cluster centroid in a river snaps to
   * the closest footpath/bridge on shore.
   */
  nearest(
    point: [number, number],
    profile: Routing.RoutingProfile,
  ): Promise<[number, number] | null>;
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
  /**
   * Global concurrency cap on outbound OSRM requests. Configurable via
   * `OSRM_MAX_CONCURRENCY` env (default 8). Keeps the single-process
   * osrm-routed server from being overwhelmed when multiple users plan
   * tours at the same time; surplus requests queue. See `withSemaphore`.
   */
  private readonly maxConcurrency: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.base = (config.get<string>("OSRM_URL") ?? "http://osrm:5000").replace(
      /\/+$/,
      "",
    );
    const raw = config.get<string>("OSRM_MAX_CONCURRENCY");
    const parsed = raw === undefined ? 8 : Number.parseInt(raw, 10);
    this.maxConcurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
    this.logger.log(
      `OSRM client → ${this.base} (max concurrency ${this.maxConcurrency})`,
    );
  }

  /**
   * Acquire a slot in the global semaphore, run `fn`, release. The queue
   * is FIFO. Failures still release the slot. The bound applies across
   * all instance callers — that's the whole point. The Nest container
   * defaults this provider to a singleton, so all controllers share one
   * counter.
   */
  private async withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  route(
    from: [number, number],
    to: [number, number],
    profile: Routing.RoutingProfile,
  ): Promise<OsrmLeg | null> {
    return this.withSemaphore(async () => {
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
    });
  }

  routeAlternatives(
    from: [number, number],
    to: [number, number],
    profile: Routing.RoutingProfile,
    count: number,
  ): Promise<OsrmLeg[]> {
    if (count < 1) return Promise.resolve([]);
    return this.withSemaphore(async () => {
      // OSRM's `alternatives` parameter accepts an integer = additional routes
      // beyond the primary (alternatives=2 → up to 3 total routes). Capped at
      // 5 — anything higher rarely produces useful variants for foot routing
      // on dense urban networks.
      const altParam = Math.min(Math.max(0, count - 1), 5);
      const url =
        `${this.base}/route/v1/${profile}/${fmt(from)};${fmt(to)}` +
        `?overview=full&geometries=geojson&steps=false&annotations=false` +
        `&alternatives=${altParam}`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OSRM /route ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as OsrmRouteResponse;
      if (json.code !== "Ok" || !json.routes || json.routes.length === 0) {
        return [];
      }
      const legs: OsrmLeg[] = [];
      for (const r of json.routes) {
        if (r.geometry.type !== "LineString") continue;
        legs.push({
          meters: r.distance,
          seconds: r.duration,
          geometry: r.geometry as Geo.GeoJsonLineString,
        });
      }
      return legs;
    });
  }

  routeMulti(
    coords: readonly [number, number][],
    profile: Routing.RoutingProfile,
  ): Promise<OsrmLeg | null> {
    if (coords.length < 2) return Promise.resolve(null);
    return this.withSemaphore(async () => {
      const url =
        `${this.base}/route/v1/${profile}/${coords.map(fmt).join(";")}` +
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
    });
  }

  table(
    coords: readonly [number, number][],
    profile: Routing.RoutingProfile,
  ): Promise<(OsrmMatrixEntry | null)[][]> {
    if (coords.length === 0) return Promise.resolve([]);
    if (coords.length === 1)
      return Promise.resolve([[{ meters: 0, seconds: 0 }]]);
    return this.withSemaphore(async () => {
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
    });
  }

  nearest(
    point: [number, number],
    profile: Routing.RoutingProfile,
  ): Promise<[number, number] | null> {
    return this.withSemaphore(async () => {
      const url = `${this.base}/nearest/v1/${profile}/${fmt(point)}?number=1`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OSRM /nearest ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        code: string;
        waypoints?: Array<{ location?: [number, number] }>;
      };
      if (json.code !== "Ok" || !json.waypoints || json.waypoints.length === 0)
        return null;
      const loc = json.waypoints[0]?.location;
      if (!loc) return null;
      return [loc[0], loc[1]];
    });
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
    } catch (err) {
      // `fetch failed` from undici is opaque — surface the actual cause and
      // a hint about the OSRM_URL env so the dev knows what to fix. The most
      // common gotcha: `OSRM_URL` defaults to `http://osrm:5000` (the compose
      // hostname); running the API outside compose needs `http://localhost:5000`.
      const cause = (err as { cause?: Error }).cause;
      const detail = cause?.message ?? (err as Error).message;
      throw new Error(
        `OSRM request to ${this.base} failed: ${detail}. ` +
          `Check that the OSRM container is up (docker compose ps osrm) and that ` +
          `OSRM_URL points to it — host-side dev typically wants ` +
          `OSRM_URL=http://localhost:5000.`,
        { cause: err as Error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function fmt(p: [number, number]): string {
  return `${p[0]},${p[1]}`;
}
