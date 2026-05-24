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
    if (caches.length === 0) {
      return { insertedOrUpdated: 0, waypointsInserted: 0 };
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

      // Replace additional waypoints for caches that came in this batch.
      const affectedCacheIds = Array.from(cacheIdByCode.values());
      if (affectedCacheIds.length > 0) {
        await tx
          .deleteFrom("additional_waypoints")
          .where("cache_id", "in", affectedCacheIds)
          .execute();
      }

      let waypointsInserted = 0;
      const matchedWaypoints = waypoints
        .map((w) => {
          const cacheId = cacheIdByCode.get(w.parentCode);
          return cacheId === undefined ? null : { w, cacheId };
        })
        .filter((x): x is { w: ParsedWaypoint; cacheId: number } => x !== null);

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

      return { insertedOrUpdated, waypointsInserted };
    });
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
