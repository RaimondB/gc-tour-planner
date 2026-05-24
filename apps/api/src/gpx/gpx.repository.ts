// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { ParsedCache, ParsedWaypoint } from "@gctp/shared/gpx";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export interface UpsertCachesResult {
  insertedOrUpdated: number;
  waypointsInserted: number;
  /** Map of cache code → DB row id for every cache touched by this upload. */
  cacheIdByCode: ReadonlyMap<string, number>;
}

@Injectable()
export class GpxRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Upsert a batch of caches and their additional waypoints for a given owner.
   * Runs in a single transaction so a partial failure leaves no orphan rows.
   *
   * Waypoint replacement strategy: for every cache present in `caches`, we wipe
   * its existing `additional_waypoints` and re-insert. This matches PQ semantics
   * — a re-uploaded PQ is the new source of truth for that cache.
   */
  async upsertFromGpx(
    ownerId: string,
    caches: readonly ParsedCache[],
    waypoints: readonly ParsedWaypoint[],
  ): Promise<UpsertCachesResult> {
    if (caches.length === 0 && waypoints.length === 0) {
      return {
        insertedOrUpdated: 0,
        waypointsInserted: 0,
        cacheIdByCode: new Map(),
      };
    }

    return this.db.transaction().execute(async (tx) => {
      let insertedOrUpdated = 0;
      const cacheIdByCode = new Map<string, number>();

      for (const c of caches) {
        const row = await tx
          .insertInto("caches")
          .values({
            owner_id: ownerId,
            source: "gpx",
            source_id: c.sourceId,
            code: c.code,
            type: c.type,
            name: c.name,
            location: sql<string>`ST_SetSRID(ST_MakePoint(${c.location[0]}, ${c.location[1]}), 4326)::geography`,
            difficulty: c.difficulty,
            terrain: c.terrain,
            size: c.size,
            archived: c.archived,
            raw: sql<string>`'{}'::jsonb`,
          })
          .onConflict((oc) =>
            oc
              .columns(["owner_id", "source", "source_id"])
              // Matches the partial unique index `caches_owner_source_id_idx`.
              .where("owner_id", "is not", null)
              .doUpdateSet({
                code: (eb) => eb.ref("excluded.code"),
                type: (eb) => eb.ref("excluded.type"),
                name: (eb) => eb.ref("excluded.name"),
                location: (eb) => eb.ref("excluded.location"),
                difficulty: (eb) => eb.ref("excluded.difficulty"),
                terrain: (eb) => eb.ref("excluded.terrain"),
                size: (eb) => eb.ref("excluded.size"),
                archived: (eb) => eb.ref("excluded.archived"),
                last_seen_at: sql<Date>`now()`,
              }),
          )
          .returning("id")
          .executeTakeFirstOrThrow();

        cacheIdByCode.set(c.code, Number(row.id));
        insertedOrUpdated += 1;

        // Replace attributes for this cache.
        await tx
          .deleteFrom("cache_attributes")
          .where("cache_id", "=", row.id)
          .execute();
        if (c.attributes.length > 0) {
          await tx
            .insertInto("cache_attributes")
            .values(
              c.attributes.map((a) => ({
                cache_id: Number(row.id),
                attr_id: a.id,
                positive: a.positive,
              })),
            )
            .execute();
        }
      }

      // Resolve parent caches for incoming waypoints. PQs ship caches in
      // foo.gpx and additional waypoints in foo-wpts.gpx as separate files,
      // so the parent often isn't in the current batch — fall back to caches
      // already owned by this user.
      const codeToCacheId = new Map(cacheIdByCode);
      const unresolvedCodes = Array.from(
        new Set(
          waypoints
            .map((w) => w.parentCode)
            .filter((code) => !codeToCacheId.has(code)),
        ),
      );
      if (unresolvedCodes.length > 0) {
        const rows = await tx
          .selectFrom("caches")
          .select(["id", "code"])
          .where("owner_id", "=", ownerId)
          .where("code", "in", unresolvedCodes)
          .execute();
        for (const r of rows) codeToCacheId.set(r.code, Number(r.id));
      }

      // Replace additional waypoints for every cache the incoming waypoints
      // touch — both the caches in this batch and the cross-batch parents we
      // just resolved. Otherwise a re-uploaded -wpts.gpx would double-insert.
      const matchedWaypoints = waypoints
        .map((w) => {
          const cacheId = codeToCacheId.get(w.parentCode);
          return cacheId === undefined ? null : { w, cacheId };
        })
        .filter((x): x is { w: ParsedWaypoint; cacheId: number } => x !== null);

      const affectedCacheIds = Array.from(
        new Set([
          ...cacheIdByCode.values(),
          ...matchedWaypoints.map((m) => m.cacheId),
        ]),
      );
      if (affectedCacheIds.length > 0) {
        await tx
          .deleteFrom("additional_waypoints")
          .where("cache_id", "in", affectedCacheIds)
          .execute();
      }

      let waypointsInserted = 0;

      if (matchedWaypoints.length > 0) {
        await tx
          .insertInto("additional_waypoints")
          .values(
            matchedWaypoints.map(({ w, cacheId }) => ({
              cache_id: cacheId,
              type: w.type,
              location: sql<string>`ST_SetSRID(ST_MakePoint(${w.location[0]}, ${w.location[1]}), 4326)::geography`,
              note: w.note,
            })),
          )
          .execute();
        waypointsInserted = matchedWaypoints.length;
      }

      return { insertedOrUpdated, waypointsInserted, cacheIdByCode };
    });
  }

  /**
   * Idempotently mark a batch of caches as found by `userId`. Returns the
   * number of new find rows written (existing rows are left untouched).
   */
  async recordFinds(
    userId: string,
    cacheIds: readonly number[],
    source: "manual" | "gpx-finds-import",
  ): Promise<number> {
    if (cacheIds.length === 0) return 0;
    const inserted = await this.db
      .insertInto("cache_finds")
      .values(
        cacheIds.map((cache_id) => ({
          cache_id,
          user_id: userId,
          source,
        })),
      )
      .onConflict((oc) => oc.columns(["cache_id", "user_id"]).doNothing())
      .returning("cache_id")
      .execute();
    return inserted.length;
  }

  async recordUpload(
    ownerId: string,
    filename: string,
    parsedCount: number,
    status: "parsed" | "failed",
    error: string | null,
  ): Promise<string> {
    const row = await this.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename,
        parsed_count: parsedCount,
        status,
        error,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
