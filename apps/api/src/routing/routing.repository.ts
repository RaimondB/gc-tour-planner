// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Geo, Routing } from "@gctp/shared";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";
import { isImpossibleSpeed } from "./leg-sanity.js";

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
  private readonly logger = new Logger(RoutingRepository.name);

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Look up every cached leg in `pairs` in a single query. Caller pairs the
   * results back to the original ordering — we don't return them in input
   * order on purpose so the service can detect misses by set diff.
   */
  async findLegs(
    pairs: readonly { fromCacheId: number; toCacheId: number }[],
    profile: Routing.RoutingProfile,
    osrmVersion: string,
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
    const wanted = new Set(pairs.map((p) => `${p.fromCacheId}:${p.toCacheId}`));

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
      .where("osrm_version", "=", osrmVersion)
      .where("from_cache_id", "in", fromIds)
      .where("to_cache_id", "in", toIds)
      // findLegs returns geometry-bearing routes only. A matrix-only cache
      // cell (source='table', geom NULL) is a hit for findMatrixCells but a
      // MISS here — caller falls through to OSRM /route, which upgrades the
      // row in place to source='route' via upsertLegs.
      .where("geom", "is not", null)
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

  /**
   * Cache-write for full /route legs (with geometry). Upserts on the PK
   * (from, to, profile). Always writes `source='route'`; if a 'table' row
   * existed it gets upgraded in place.
   *
   * Sanity guard: rows whose (meters, seconds) implies an impossible walking
   * speed (< 1 km/h or > 28 km/h) are silently dropped — see leg-sanity.ts.
   * Rejecting at the persistence boundary keeps the DB free of cells that
   * the planner would have to filter on every read anyway.
   */
  async upsertLegs(
    legs: readonly PersistLegInput[],
    osrmVersion: string,
  ): Promise<void> {
    if (legs.length === 0) return;
    const accepted: PersistLegInput[] = [];
    let dropped = 0;
    for (const l of legs) {
      if (isImpossibleSpeed(l.meters, l.seconds)) {
        dropped += 1;
        continue;
      }
      accepted.push(l);
    }
    if (dropped > 0) {
      this.logger.warn(
        `upsertLegs: dropped ${dropped} cells with impossible walking speed`,
      );
    }
    if (accepted.length === 0) return;
    await this.db
      .insertInto("route_legs")
      .values(
        accepted.map((l) => ({
          from_cache_id: l.fromCacheId,
          to_cache_id: l.toCacheId,
          profile: l.profile,
          meters: l.meters,
          seconds: l.seconds,
          source: "route",
          osrm_version: osrmVersion,
          geom: sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(l.geometry)}), 4326)::geography`,
        })),
      )
      .onConflict((oc) =>
        oc.columns(["from_cache_id", "to_cache_id", "profile"]).doUpdateSet({
          meters: (eb) => eb.ref("excluded.meters"),
          seconds: (eb) => eb.ref("excluded.seconds"),
          source: (eb) => eb.ref("excluded.source"),
          geom: (eb) => eb.ref("excluded.geom"),
          osrm_version: (eb) => eb.ref("excluded.osrm_version"),
          fetched_at: sql<Date>`now()`,
        }),
      )
      .execute();
  }

  /**
   * Sparse matrix-cell cache: meters + seconds only, no geometry. Used by Pass 1
   * cluster discovery. INSERT … DO NOTHING — never downgrade a 'route' row to
   * 'table'. Pass 2's upsertLegs() can still upgrade a 'table' row to 'route'
   * later (its DO UPDATE SET overwrites source).
   *
   * Chunks at 5 000 rows per INSERT (≈ 35 k bind parameters @ 7 cols, safely
   * under Postgres's 65 535 hard cap). A single 1000-cache Pass 1 run with
   * k=12 produces ~24 k cells, so the chunking kicks in.
   */
  async upsertMatrixCells(
    cells: readonly {
      fromCacheId: number;
      toCacheId: number;
      profile: Routing.RoutingProfile;
      meters: number;
      seconds: number;
    }[],
    osrmVersion: string,
  ): Promise<void> {
    if (cells.length === 0) return;
    // Drop cells with impossible walking speed before they land in the DB.
    // The detour-ratio guard needs the haversine context the walking-graph
    // builder has but the repo doesn't, so it stays upstream.
    const accepted: typeof cells = cells.filter(
      (c) => !isImpossibleSpeed(c.meters, c.seconds),
    );
    const dropped = cells.length - accepted.length;
    if (dropped > 0) {
      this.logger.warn(
        `upsertMatrixCells: dropped ${dropped} cells with impossible walking speed`,
      );
    }
    if (accepted.length === 0) return;
    const CHUNK = 5_000;
    // DO UPDATE only when the incoming row carries a newer extract version
    // than the existing one — never downgrade a `source='route'` row (with
    // geometry) to a `source='table'` row for the same version (see commit
    // b688587). Crossing extracts is the one case where we *do* want to
    // overwrite, because the geometry is bound to a specific extract.
    for (let i = 0; i < accepted.length; i += CHUNK) {
      const slice = accepted.slice(i, i + CHUNK);
      await this.db
        .insertInto("route_legs")
        .values(
          slice.map((c) => ({
            from_cache_id: c.fromCacheId,
            to_cache_id: c.toCacheId,
            profile: c.profile,
            meters: c.meters,
            seconds: c.seconds,
            source: "table",
            osrm_version: osrmVersion,
            geom: null,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(["from_cache_id", "to_cache_id", "profile"])
            .doUpdateSet({
              meters: (eb) => eb.ref("excluded.meters"),
              seconds: (eb) => eb.ref("excluded.seconds"),
              source: (eb) => eb.ref("excluded.source"),
              geom: (eb) => eb.ref("excluded.geom"),
              osrm_version: (eb) => eb.ref("excluded.osrm_version"),
              fetched_at: sql<Date>`now()`,
            })
            .where(
              sql<boolean>`route_legs.osrm_version <> excluded.osrm_version`,
            ),
        )
        .execute();
    }
  }

  /**
   * Negative cache for cache pairs OSRM cannot route between. Without this
   * row, every cluster discovery re-asks OSRM for the same unreachable
   * pair (precompute can't store "no route exists" via upsertMatrixCells
   * because meters NOT NULL). source='noroute' rows have meters/seconds/
   * geom all NULL by the DB CHECK. INSERT … DO NOTHING — never overwrite
   * a real route with a noroute marker; if a future extract gains a
   * connecting edge, the upsertMatrixCells path will replace the marker
   * via the osrm_version mismatch branch.
   */
  async upsertNorouteCells(
    cells: readonly {
      fromCacheId: number;
      toCacheId: number;
      profile: Routing.RoutingProfile;
    }[],
    osrmVersion: string,
  ): Promise<void> {
    if (cells.length === 0) return;
    const CHUNK = 5_000;
    for (let i = 0; i < cells.length; i += CHUNK) {
      const slice = cells.slice(i, i + CHUNK);
      await this.db
        .insertInto("route_legs")
        .values(
          slice.map((c) => ({
            from_cache_id: c.fromCacheId,
            to_cache_id: c.toCacheId,
            profile: c.profile,
            meters: null,
            seconds: null,
            source: "noroute",
            osrm_version: osrmVersion,
            geom: null,
          })),
        )
        // Same osrm-version-mismatch guard as upsertMatrixCells: across
        // extracts the row gets re-evaluated; within an extract the
        // earlier negative result stands.
        .onConflict((oc) =>
          oc
            .columns(["from_cache_id", "to_cache_id", "profile"])
            .doUpdateSet({
              meters: (eb) => eb.ref("excluded.meters"),
              seconds: (eb) => eb.ref("excluded.seconds"),
              source: (eb) => eb.ref("excluded.source"),
              geom: (eb) => eb.ref("excluded.geom"),
              osrm_version: (eb) => eb.ref("excluded.osrm_version"),
              fetched_at: sql<Date>`now()`,
            })
            .where(
              sql<boolean>`route_legs.osrm_version <> excluded.osrm_version`,
            ),
        )
        .execute();
    }
  }

  /**
   * Sparse matrix-cell lookup: meters + seconds for the given pairs, ignoring
   * geometry. Returns rows for 'table', 'route', AND 'noroute' sources —
   * a noroute row signals "OSRM was asked and said no" so the caller can
   * skip the pair without re-querying. Noroute rows carry meters=0,
   * seconds=0 and an explicit `noroute: true` flag so callers can branch.
   */
  async findMatrixCells(
    pairs: readonly { fromCacheId: number; toCacheId: number }[],
    profile: Routing.RoutingProfile,
    osrmVersion: string,
  ): Promise<
    Array<{
      fromCacheId: number;
      toCacheId: number;
      meters: number;
      seconds: number;
      noroute: boolean;
    }>
  > {
    if (pairs.length === 0) return [];
    const fromIds = Array.from(new Set(pairs.map((p) => p.fromCacheId)));
    const toIds = Array.from(new Set(pairs.map((p) => p.toCacheId)));
    const wanted = new Set(pairs.map((p) => `${p.fromCacheId}:${p.toCacheId}`));
    const rows = (await this.db
      .selectFrom("route_legs")
      .select(["from_cache_id", "to_cache_id", "meters", "seconds", "source"])
      .where("profile", "=", profile)
      .where("osrm_version", "=", osrmVersion)
      .where("from_cache_id", "in", fromIds)
      .where("to_cache_id", "in", toIds)
      .execute()) as unknown as Array<{
      from_cache_id: string;
      to_cache_id: string;
      meters: string | null;
      seconds: string | null;
      source: string;
    }>;
    return rows
      .filter((r) => wanted.has(`${r.from_cache_id}:${r.to_cache_id}`))
      .map((r) => ({
        fromCacheId: Number(r.from_cache_id),
        toCacheId: Number(r.to_cache_id),
        meters: r.source === "noroute" ? 0 : Number(r.meters),
        seconds: r.source === "noroute" ? 0 : Number(r.seconds),
        noroute: r.source === "noroute",
      }));
  }

  /**
   * Owner-scoped read of suspicious `route_legs` rows (mirror of
   * `deleteSuspiciousLegs` selection). Used by the walking-graph debug
   * endpoint to surface bogus cells in the UI even after the planner-side
   * read-time filter has stripped them from clustering input — without
   * this, the user can't see (or purge) what's still in the database.
   */
  async findSuspiciousLegs(
    ownerId: string,
    cacheIds: readonly number[],
    profile: Routing.RoutingProfile,
    walkingMaxMeters: number,
    haversineMinMeters: number,
    osrmVersion: string,
  ): Promise<
    Array<{
      fromCacheId: number;
      toCacheId: number;
      meters: number;
      seconds: number;
      haversineM: number;
    }>
  > {
    if (cacheIds.length === 0) return [];
    const ids = cacheIds.join(",");
    const rows = (
      await sql<{
        from_cache_id: string;
        to_cache_id: string;
        meters: string;
        seconds: string;
        haversine_m: number;
      }>`
      WITH owner_caches AS (
        SELECT id, location
          FROM caches
         WHERE owner_id = ${ownerId}
           AND id IN (${sql.raw(ids)})
      )
      SELECT rl.from_cache_id,
             rl.to_cache_id,
             rl.meters,
             rl.seconds,
             ST_Distance(a.location, b.location) AS haversine_m
        FROM route_legs rl
        JOIN owner_caches a ON a.id = rl.from_cache_id
        JOIN owner_caches b ON b.id = rl.to_cache_id
       WHERE rl.profile = ${profile}
         AND rl.osrm_version = ${osrmVersion}
         AND rl.meters  <= ${walkingMaxMeters}
         AND ST_Distance(a.location, b.location) >= ${haversineMinMeters}
    `.execute(this.db)
    ).rows;
    return rows.map((r) => ({
      fromCacheId: Number(r.from_cache_id),
      toCacheId: Number(r.to_cache_id),
      meters: Number(r.meters),
      seconds: Number(r.seconds),
      haversineM: Number(r.haversine_m),
    }));
  }

  /**
   * Delete `route_legs` rows whose stored walking distance is below
   * `walkingMaxMeters` for cache pairs whose haversine distance is above
   * `haversineMinMeters`. These are stale/bogus cells (OSRM doesn't return 0
   * for distinct, non-co-located coords) and ON CONFLICT DO NOTHING means
   * they never get refreshed on their own.
   *
   * Returns the number of rows deleted. Only touches the owner's caches —
   * `route_legs` has FKs to `caches`, which are owner-scoped, so the
   * `from_cache_id IN (caches.id WHERE owner_id = ?)` join filters by owner
   * implicitly.
   */
  async deleteSuspiciousLegs(
    ownerId: string,
    cacheIds: readonly number[],
    profile: Routing.RoutingProfile,
    walkingMaxMeters: number,
    haversineMinMeters: number,
    osrmVersion: string,
  ): Promise<number> {
    if (cacheIds.length === 0) return 0;
    // Use raw SQL so we can join route_legs to a self-join on caches to
    // compute haversine via ST_Distance in one statement. Kysely's DELETE …
    // USING form is awkward to express portably; raw is clearer here.
    //
    // Version-scoped: purge the live extract's cells only. Rows from a
    // previous extract are already invisible to the planner read path, so
    // deleting them gives no functional benefit and could surprise the
    // operator who wanted "purge what the planner sees right now".
    const ids = cacheIds.join(",");
    const result = await sql<{ deleted: number }>`
      WITH owner_caches AS (
        SELECT id, location
          FROM caches
         WHERE owner_id = ${ownerId}
           AND id IN (${sql.raw(ids)})
      ),
      bogus AS (
        SELECT rl.from_cache_id, rl.to_cache_id, rl.profile
          FROM route_legs rl
          JOIN owner_caches a ON a.id = rl.from_cache_id
          JOIN owner_caches b ON b.id = rl.to_cache_id
         WHERE rl.profile = ${profile}
           AND rl.osrm_version = ${osrmVersion}
           AND rl.meters  <= ${walkingMaxMeters}
           AND ST_Distance(a.location, b.location) >= ${haversineMinMeters}
      ),
      del AS (
        DELETE FROM route_legs rl
         USING bogus
         WHERE rl.from_cache_id = bogus.from_cache_id
           AND rl.to_cache_id   = bogus.to_cache_id
           AND rl.profile       = bogus.profile
        RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted FROM del
    `.execute(this.db);
    return result.rows[0]?.deleted ?? 0;
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
