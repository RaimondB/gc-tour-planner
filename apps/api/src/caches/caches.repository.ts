// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import { Caches } from "@gctp/shared";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export interface FindCachesParams {
  ownerId: string;
  center: [number, number];
  radiusM: number;
  types?: readonly Caches.CacheType[];
  /** AND-of-OR groups; an empty outer array means "no attribute filter". */
  attributeGroups?: readonly (readonly Caches.AttributeFilter[])[];
  /** When true, exclude caches the current user has logged as found. */
  excludeFound?: boolean;
  /**
   * Hard filter: cache must be inside at least one landuse_polygons polygon
   * whose `kind` is in this list. Relies on the OSM landuse cache being warm
   * for the relevant cells — the web app calls /landuse before /caches to
   * guarantee that.
   */
  contexts?: readonly string[];
  /**
   * Include caches the owner has temporarily disabled (FR-I10).
   * Default false — `listCaches` excludes them so the planner never
   * picks one as a visit target. The filter sidebar's "Show disabled"
   * chip flips this to true; the map then renders them at 50 %
   * opacity with a "Z" overlay.
   */
  includeDisabled?: boolean;
  /**
   * Include archived caches. Default false. No UI today; reserved
   * for a future debug overlay (archived caches are normally noise).
   */
  includeArchived?: boolean;
  /**
   * Exclude Mystery-type caches that have no solved coordinate. Other types
   * are unaffected. Implemented as `NOT (type='Mystery' AND solved=false)`.
   */
  solvedMysteriesOnly?: boolean;
  /**
   * Multi sub-type filter (FR-SF2). `"all"`/undefined = no narrowing. Applied
   * server-side (post-projection, via `classifyMulti(stageCount)`) so the
   * planner's cache pool matches the map.
   */
  multiSubtype?: Caches.MultiSubtypeFilter;
  /** Hide caches that require special equipment (FR-SF6). Server-side. */
  hideToolCaches?: boolean;
}

interface CacheRow {
  id: string;
  source: string;
  source_id: string;
  code: string;
  type: string;
  name: string;
  lng: number;
  lat: number;
  difficulty: string | null;
  terrain: string | null;
  size: string | null;
  archived: boolean;
  disabled: boolean;
  solved: boolean;
  /** ST_X/ST_Y of published_location; both null when not solved / unknown. */
  posted_lng: number | null;
  posted_lat: number | null;
  attribute_ids: number[];
  parking_lngs: number[];
  parking_lats: number[];
  found_by_me: boolean;
  /** FR-SF1: COUNT of additional_waypoints rows with type='stages' for this cache. */
  stage_count: number;
  /**
   * FR-SF8: scanned hint keys; NULL when the row predates PR3 and was
   * never re-parsed. Empty array when scanned but nothing matched.
   */
  description_hints: string[] | null;
}

@Injectable()
export class CachesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async find(p: FindCachesParams): Promise<Caches.CacheDTO[]> {
    const [lng, lat] = p.center;

    let q = this.db
      .selectFrom("caches as c")
      .select((eb) => [
        "c.id",
        "c.source",
        "c.source_id",
        "c.code",
        "c.type",
        "c.name",
        sql<number>`ST_X(c.location::geometry)`.as("lng"),
        sql<number>`ST_Y(c.location::geometry)`.as("lat"),
        "c.difficulty",
        "c.terrain",
        "c.size",
        "c.archived",
        "c.disabled",
        "c.solved",
        sql<number | null>`ST_X(c.published_location::geometry)`.as(
          "posted_lng",
        ),
        sql<number | null>`ST_Y(c.published_location::geometry)`.as(
          "posted_lat",
        ),
        eb
          .selectFrom("cache_attributes as a")
          .whereRef("a.cache_id", "=", "c.id")
          .where("a.positive", "=", true)
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(a.attr_id ORDER BY a.attr_id), ARRAY[]::int[])`.as(
              "attribute_ids",
            ),
          )
          .as("attribute_ids"),
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "parking")
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(ST_X(w.location::geometry)), ARRAY[]::float8[])`.as(
              "parking_lngs",
            ),
          )
          .as("parking_lngs"),
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "parking")
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(ST_Y(w.location::geometry)), ARRAY[]::float8[])`.as(
              "parking_lats",
            ),
          )
          .as("parking_lats"),
        eb
          .exists(
            eb
              .selectFrom("cache_finds as f")
              .select(sql<number>`1`.as("one"))
              .whereRef("f.cache_id", "=", "c.id")
              .where("f.user_id", "=", p.ownerId),
          )
          .as("found_by_me"),
        // FR-SF1: count of 'stages' additional waypoints. The web's
        // FilterSidebar uses this to bucket Multis as mini (≤2) vs
        // full (≥3). Indexed by additional_waypoints_cache_idx.
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "stages")
          .select(sql<number>`COUNT(*)::int`.as("stage_count"))
          .as("stage_count"),
        "c.description_hints",
      ])
      .where("c.owner_id", "=", p.ownerId)
      .where(
        sql<boolean>`ST_DWithin(c.location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${p.radiusM})`,
      );

    // FR-I10 default filter: hide archived + disabled unless the
    // caller asked otherwise. The partial index
    // `caches_owner_active_idx (owner_id) WHERE NOT archived AND NOT disabled`
    // supports this hot path.
    if (!p.includeArchived) {
      q = q.where("c.archived", "=", false);
    }
    if (!p.includeDisabled) {
      q = q.where("c.disabled", "=", false);
    }

    if (p.excludeFound) {
      q = q.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("cache_finds as f")
              .select(sql<number>`1`.as("one"))
              .whereRef("f.cache_id", "=", "c.id")
              .where("f.user_id", "=", p.ownerId),
          ),
        ),
      );
    }

    if (p.contexts && p.contexts.length > 0) {
      const contexts = p.contexts;
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom("landuse_polygons as l")
            .select(sql<number>`1`.as("one"))
            .where("l.kind", "in", contexts as unknown as string[])
            .where(sql<boolean>`ST_Contains(l.geom, c.location::geometry)`),
        ),
      );
    }

    if (p.types && p.types.length > 0) {
      q = q.where("c.type", "in", p.types as unknown as string[]);
    }

    // "Only solved mysteries": drop Mystery caches without a solved
    // coordinate; every other type passes through. Served by the partial
    // index `caches_owner_solved_idx` for the solved subset.
    if (p.solvedMysteriesOnly) {
      q = q.where(sql<boolean>`NOT (c.type = 'Mystery' AND c.solved = false)`);
    }

    if (p.attributeGroups && p.attributeGroups.length > 0) {
      for (const group of p.attributeGroups) {
        if (group.length === 0) continue;
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom("cache_attributes as ca")
              .select(sql<number>`1`.as("one"))
              .whereRef("ca.cache_id", "=", "c.id")
              .where((eb2) =>
                eb2.or(
                  group.map((f) =>
                    eb2.and([
                      eb2("ca.attr_id", "=", f.id),
                      eb2("ca.positive", "=", f.positive),
                    ]),
                  ),
                ),
              ),
          ),
        );
      }
    }

    const rows = (await q.execute()) as unknown as CacheRow[];

    const dtos = rows.map<Caches.CacheDTO>((r) => {
      const parking: Caches.CacheDTO["parkingPoints"] = [];
      const lngs = r.parking_lngs ?? [];
      const lats = r.parking_lats ?? [];
      for (let i = 0; i < lngs.length && i < lats.length; i += 1) {
        const plng = lngs[i];
        const plat = lats[i];
        if (typeof plng === "number" && typeof plat === "number")
          parking.push([plng, plat]);
      }

      return {
        id: Number(r.id),
        source: r.source,
        sourceId: r.source_id,
        code: r.code,
        type: r.type as Caches.CacheType,
        name: r.name,
        location: { type: "Point", coordinates: [r.lng, r.lat] },
        difficulty: r.difficulty === null ? null : Number(r.difficulty),
        terrain: r.terrain === null ? null : Number(r.terrain),
        size: r.size,
        archived: r.archived,
        disabled: r.disabled,
        solved: r.solved,
        postedLocation:
          typeof r.posted_lng === "number" && typeof r.posted_lat === "number"
            ? { type: "Point", coordinates: [r.posted_lng, r.posted_lat] }
            : null,
        attributeIds: r.attribute_ids ?? [],
        parkingPoints: parking,
        foundByMe: Boolean(r.found_by_me),
        stageCount: r.stage_count ?? 0,
        // NULL `description_hints` (pre-PR3 rows) maps to an empty
        // array on the DTO. The web layer can't tell "never scanned"
        // apart from "scanned, no hits" — that distinction stays in
        // the DB so the admin reprocess flow can spot back-fill
        // targets via WHERE description_hints IS NULL.
        descriptionHints: r.description_hints ?? [],
      };
    });

    // FR-SF2 / FR-SF6 applied server-side (post-projection — they need
    // stageCount + attribute/hint data) so the planner's discovery pool, which
    // calls this same method, matches exactly what the map shows. Type and
    // spatial filters already ran in SQL above.
    let result = dtos;
    if (p.hideToolCaches) {
      result = result.filter(
        (c) => !Caches.hasToolRequirement(c.attributeIds, c.descriptionHints),
      );
    }
    if (p.multiSubtype && p.multiSubtype !== "all") {
      const want = p.multiSubtype;
      result = result.filter(
        (c) =>
          c.type !== "Multi" || Caches.classifyMulti(c.stageCount) === want,
      );
    }
    return result;
  }

  /**
   * Idempotent mark-as-found for a single cache. Returns true if a new row
   * was written, false if the cache was already marked.
   */
  async markFound(userId: string, cacheId: number): Promise<boolean> {
    const rows = await this.db
      .insertInto("cache_finds")
      .values({ cache_id: cacheId, user_id: userId, source: "manual" })
      .onConflict((oc) => oc.columns(["cache_id", "user_id"]).doNothing())
      .returning("cache_id")
      .execute();
    return rows.length > 0;
  }

  async unmarkFound(userId: string, cacheId: number): Promise<boolean> {
    const rows = await this.db
      .deleteFrom("cache_finds")
      .where("cache_id", "=", cacheId)
      .where("user_id", "=", userId)
      .returning("cache_id")
      .execute();
    return rows.length > 0;
  }

  /**
   * Remove a cache's solved coordinate: revert `location` to the posted coord
   * (`COALESCE(published_location, location)` — when the cache was first seen
   * via a solved upload there's no posted coord to fall back to, so `location`
   * stays put) and clear the solved flag. Owner-scoped and idempotent.
   *
   * Reverting `location` moves the cache, so its location-derived precompute
   * is invalidated in the same transaction (route_legs both directions +
   * cache_landuse); the caller re-warms via the walking-precompute queue.
   * Returns true when a solved row was actually cleared.
   */
  async clearSolved(userId: string, cacheId: number): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const reverted = await tx
        .updateTable("caches")
        .set({
          solved: false,
          solved_at: null,
          location: sql<string>`COALESCE(published_location, location)`,
        })
        .where("id", "=", cacheId)
        .where("owner_id", "=", userId)
        .where("solved", "=", true)
        .returning("id")
        .executeTakeFirst();
      if (!reverted) return false;

      await tx
        .deleteFrom("route_legs")
        .where((eb) =>
          eb.or([
            eb("from_cache_id", "=", cacheId),
            eb("to_cache_id", "=", cacheId),
          ]),
        )
        .execute();
      await tx
        .deleteFrom("cache_landuse")
        .where("cache_id", "=", cacheId)
        .execute();
      return true;
    });
  }

  /**
   * Fetch a specific set of caches by id, restricted to caches the user owns
   * (or world-readable public-source rows once those land in M7). Returns one
   * `CacheDTO` per id found; the caller decides whether a partial result is
   * acceptable. Re-uses the same projection as `find` so consumers see the
   * same shape (including parkingPoints + foundByMe).
   */
  async findByIds(
    userId: string,
    ids: readonly number[],
  ): Promise<Caches.CacheDTO[]> {
    if (ids.length === 0) return [];

    const rows = (await this.db
      .selectFrom("caches as c")
      .select((eb) => [
        "c.id",
        "c.source",
        "c.source_id",
        "c.code",
        "c.type",
        "c.name",
        sql<number>`ST_X(c.location::geometry)`.as("lng"),
        sql<number>`ST_Y(c.location::geometry)`.as("lat"),
        "c.difficulty",
        "c.terrain",
        "c.size",
        "c.archived",
        "c.disabled",
        "c.solved",
        sql<number | null>`ST_X(c.published_location::geometry)`.as(
          "posted_lng",
        ),
        sql<number | null>`ST_Y(c.published_location::geometry)`.as(
          "posted_lat",
        ),
        eb
          .selectFrom("cache_attributes as a")
          .whereRef("a.cache_id", "=", "c.id")
          .where("a.positive", "=", true)
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(a.attr_id ORDER BY a.attr_id), ARRAY[]::int[])`.as(
              "attribute_ids",
            ),
          )
          .as("attribute_ids"),
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "parking")
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(ST_X(w.location::geometry)), ARRAY[]::float8[])`.as(
              "parking_lngs",
            ),
          )
          .as("parking_lngs"),
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "parking")
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(ST_Y(w.location::geometry)), ARRAY[]::float8[])`.as(
              "parking_lats",
            ),
          )
          .as("parking_lats"),
        eb
          .exists(
            eb
              .selectFrom("cache_finds as f")
              .select(sql<number>`1`.as("one"))
              .whereRef("f.cache_id", "=", "c.id")
              .where("f.user_id", "=", userId),
          )
          .as("found_by_me"),
        // FR-SF1: same `stage_count` subquery as in `find()`. The
        // planner consumes `findByIds()` results to assemble the
        // chosen cluster — `stageCount` shows up on the tour stops
        // for the popup label.
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "stages")
          .select(sql<number>`COUNT(*)::int`.as("stage_count"))
          .as("stage_count"),
        "c.description_hints",
      ])
      .where("c.owner_id", "=", userId)
      .where("c.id", "in", ids as unknown as number[])
      .execute()) as unknown as CacheRow[];

    return rows.map<Caches.CacheDTO>((r) => {
      const parking: Caches.CacheDTO["parkingPoints"] = [];
      const lngs = r.parking_lngs ?? [];
      const lats = r.parking_lats ?? [];
      for (let i = 0; i < lngs.length && i < lats.length; i += 1) {
        const plng = lngs[i];
        const plat = lats[i];
        if (typeof plng === "number" && typeof plat === "number")
          parking.push([plng, plat]);
      }
      return {
        id: Number(r.id),
        source: r.source,
        sourceId: r.source_id,
        code: r.code,
        type: r.type as Caches.CacheType,
        name: r.name,
        location: { type: "Point", coordinates: [r.lng, r.lat] },
        difficulty: r.difficulty === null ? null : Number(r.difficulty),
        terrain: r.terrain === null ? null : Number(r.terrain),
        size: r.size,
        archived: r.archived,
        disabled: r.disabled,
        solved: r.solved,
        postedLocation:
          typeof r.posted_lng === "number" && typeof r.posted_lat === "number"
            ? { type: "Point", coordinates: [r.posted_lng, r.posted_lat] }
            : null,
        attributeIds: r.attribute_ids ?? [],
        parkingPoints: parking,
        foundByMe: Boolean(r.found_by_me),
        stageCount: r.stage_count ?? 0,
        // NULL `description_hints` (pre-PR3 rows) maps to an empty
        // array on the DTO. The web layer can't tell "never scanned"
        // apart from "scanned, no hits" — that distinction stays in
        // the DB so the admin reprocess flow can spot back-fill
        // targets via WHERE description_hints IS NULL.
        descriptionHints: r.description_hints ?? [],
      };
    });
  }

  /**
   * Pass 1 sparse-matrix support: for each origin cache id, return its
   * `k` Haversine-nearest neighbours within `radiusM`, owned by the same user.
   *
   * Uses PostGIS `<->` (KNN operator) under a GiST index, so the per-origin
   * cost is sub-linear in pool size. Caller is expected to over-fetch
   * (3 × target k) and re-rank against OSRM walking distance — Haversine-NN
   * alone misses caches that are closest on foot but separated from a closer-
   * by-crow's-flight cache by an unwalkable barrier.
   */
  async nearestNeighbors(
    ownerId: string,
    originIds: readonly number[],
    k: number,
    radiusM: number,
  ): Promise<Array<{ fromCacheId: number; toCacheId: number }>> {
    if (originIds.length === 0 || k <= 0) return [];
    // One round-trip per origin: cheap (KNN, k≈30), and lets us reuse the
    // origin's location lookup. Could batch with a LATERAL JOIN in a single
    // query if we ever profile this as hot — for now, simplicity wins.
    const out: Array<{ fromCacheId: number; toCacheId: number }> = [];
    for (const originId of originIds) {
      const rows = (await this.db
        .selectFrom("caches as origin")
        .innerJoin("caches as neighbor", (j) =>
          j.onTrue().on("neighbor.owner_id", "=", ownerId),
        )
        .select((eb) => [
          sql<string>`neighbor.id`.as("neighbor_id"),
          sql<number>`ST_Distance(origin.location, neighbor.location)`.as(
            "meters",
          ),
        ])
        .where("origin.id", "=", originId)
        .where("origin.owner_id", "=", ownerId)
        .where("neighbor.id", "!=", originId)
        .where(
          sql<boolean>`ST_DWithin(origin.location, neighbor.location, ${radiusM})`,
        )
        .orderBy(sql`origin.location <-> neighbor.location`)
        .limit(k)
        .execute()) as unknown as { neighbor_id: string; meters: number }[];
      for (const r of rows) {
        out.push({ fromCacheId: originId, toCacheId: Number(r.neighbor_id) });
      }
    }
    return out;
  }

  /** Quick sanity check used by /caches/:id/finds — ensures the cache exists and belongs to this user. */
  async existsForOwner(userId: string, cacheId: number): Promise<boolean> {
    const row = await this.db
      .selectFrom("caches")
      .select("id")
      .where("id", "=", cacheId)
      .where("owner_id", "=", userId)
      .executeTakeFirst();
    return !!row;
  }
}
