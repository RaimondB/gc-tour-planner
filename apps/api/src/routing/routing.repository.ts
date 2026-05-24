// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Geo, Routing } from "@gctp/shared";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

interface LegRow {
  from_cache_id: string;
  to_cache_id: string;
  profile: string;
  meters: string;
  seconds: string;
  geojson: string;
}

export interface CoordRow {
  id: number;
  lng: number;
  lat: number;
}

export interface FoundLeg {
  fromCacheId: number;
  toCacheId: number;
  profile: Routing.RoutingProfile;
  meters: number;
  seconds: number;
  geometry: Geo.GeoJsonLineString;
}

export interface PersistLegInput {
  fromCacheId: number;
  toCacheId: number;
  profile: Routing.RoutingProfile;
  meters: number;
  seconds: number;
  geometry: Geo.GeoJsonLineString;
}

@Injectable()
export class RoutingRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Look up every cached leg in `pairs` in a single query. Caller pairs the
   * results back to the original ordering — we don't return them in input
   * order on purpose so the service can detect misses by set diff.
   */
  async findLegs(
    pairs: readonly { fromCacheId: number; toCacheId: number }[],
    profile: Routing.RoutingProfile,
  ): Promise<FoundLeg[]> {
    if (pairs.length === 0) return [];

    // Two flat `IN` clauses on the from/to id sets, then post-filter the
    // returned rows to the exact pairs requested. The previous shape
    // (`eb.or(pairs.map(... and(...)))`) builds a binary OR tree that Kysely's
    // query compiler walks recursively — `getMatrix` over ~100 caches builds
    // ~10k pairs and blows the JS stack (RangeError: Maximum call stack size
    // exceeded). The IN/IN form compiles flat regardless of N, and the
    // post-filter is cheap (Set membership over at most |from|×|to| rows).
    const fromIds = Array.from(new Set(pairs.map((p) => p.fromCacheId)));
    const toIds = Array.from(new Set(pairs.map((p) => p.toCacheId)));
    const wanted = new Set(
      pairs.map((p) => `${p.fromCacheId}:${p.toCacheId}`),
    );

    const rows = (await this.db
      .selectFrom("route_legs")
      .select([
        "from_cache_id",
        "to_cache_id",
        "profile",
        "meters",
        "seconds",
        sql<string>`ST_AsGeoJSON(geom::geometry)`.as("geojson"),
      ])
      .where("profile", "=", profile)
      .where("from_cache_id", "in", fromIds)
      .where("to_cache_id", "in", toIds)
      .execute()) as unknown as LegRow[];

    return rows
      .filter((r) => wanted.has(`${r.from_cache_id}:${r.to_cache_id}`))
      .map<FoundLeg>((r) => ({
        fromCacheId: Number(r.from_cache_id),
        toCacheId: Number(r.to_cache_id),
        profile: r.profile as Routing.RoutingProfile,
        meters: Number(r.meters),
        seconds: Number(r.seconds),
        geometry: JSON.parse(r.geojson) as Geo.GeoJsonLineString,
      }));
  }

  /** Cache-write. Upserts on the PK (from, to, profile). */
  async upsertLegs(legs: readonly PersistLegInput[]): Promise<void> {
    if (legs.length === 0) return;
    await this.db
      .insertInto("route_legs")
      .values(
        legs.map((l) => ({
          from_cache_id: l.fromCacheId,
          to_cache_id: l.toCacheId,
          profile: l.profile,
          meters: l.meters,
          seconds: l.seconds,
          geom: sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(l.geometry)}), 4326)::geography`,
        })),
      )
      .onConflict((oc) =>
        oc.columns(["from_cache_id", "to_cache_id", "profile"]).doUpdateSet({
          meters: (eb) => eb.ref("excluded.meters"),
          seconds: (eb) => eb.ref("excluded.seconds"),
          geom: (eb) => eb.ref("excluded.geom"),
          fetched_at: sql<Date>`now()`,
        }),
      )
      .execute();
  }

  /**
   * Look up cache coordinates for the supplied owner. Returns rows in arbitrary
   * order; caller maps by id. Missing IDs (wrong owner, deleted) are silently
   * absent — the service surfaces them as a 404.
   */
  async coordsFor(
    ownerId: string,
    cacheIds: readonly number[],
  ): Promise<CoordRow[]> {
    if (cacheIds.length === 0) return [];
    const rows = (await this.db
      .selectFrom("caches")
      .select([
        "id",
        sql<number>`ST_X(location::geometry)`.as("lng"),
        sql<number>`ST_Y(location::geometry)`.as("lat"),
      ])
      .where("id", "in", cacheIds as unknown as number[])
      .where("owner_id", "=", ownerId)
      .execute()) as unknown as { id: string; lng: number; lat: number }[];
    return rows.map((r) => ({ id: Number(r.id), lng: r.lng, lat: r.lat }));
  }
}
