// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { ParsedCache, ParsedWaypoint } from "@gctp/shared/gpx";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export type CacheUpsertOutcome = "new" | "updated" | "stale";

export interface UpsertCachesResult {
  /** Count of rows actually written (new + updated); excludes `stale`. */
  insertedOrUpdated: number;
  waypointsInserted: number;
  /**
   * Cache code → DB row id for every cache present in the upload,
   * whether it was newly written, updated, or skipped as stale. The
   * service uses this map for downstream tasks (precompute enqueue,
   * mark-as-found) that operate on the user's *current* caches, not
   * just the ones we wrote in this transaction.
   */
  cacheIdByCode: ReadonlyMap<string, number>;
  /**
   * Per-code outcome — drives the upload-response stats (`new` vs
   * `updated` vs `stale`). Stale = an existing row's
   * `source_exported_at` is newer than the incoming PQ, so the
   * upsert was a no-op for that cache (FR-I10 staleness guard).
   */
  outcome: ReadonlyMap<string, CacheUpsertOutcome>;
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
    /**
     * The PQ's `<gpx><time>` (FR-I10) — when Groundspeak generated the
     * file. Each upsert tags the touched row with this value; existing
     * rows with a newer `source_exported_at` are left alone (stale
     * skip). `null` means "we don't know when this was exported" and
     * the staleness check degrades to "always allow update".
     */
    exportedAt: Date | null,
  ): Promise<UpsertCachesResult> {
    if (caches.length === 0 && waypoints.length === 0) {
      return {
        insertedOrUpdated: 0,
        waypointsInserted: 0,
        cacheIdByCode: new Map(),
        outcome: new Map(),
      };
    }

    return this.db.transaction().execute(async (tx) => {
      let insertedOrUpdated = 0;
      const cacheIdByCode = new Map<string, number>();
      const outcome = new Map<string, CacheUpsertOutcome>();

      // Bulk-fetch existing rows so the staleness guard can be applied
      // per-cache without per-iteration round-trips. Source is always
      // 'gpx' here — different sources (OKAPI, GC.com) get their own
      // upsert paths.
      const incomingCodes = caches.map((c) => c.sourceId);
      const existingRows =
        incomingCodes.length > 0
          ? await tx
              .selectFrom("caches")
              .select(["id", "source_id", "source_exported_at"])
              .where("owner_id", "=", ownerId)
              .where("source", "=", "gpx")
              .where("source_id", "in", incomingCodes)
              .execute()
          : [];
      const existingBySourceId = new Map<
        string,
        { id: number; exportedAt: Date | null }
      >();
      for (const r of existingRows) {
        existingBySourceId.set(r.source_id, {
          id: Number(r.id),
          exportedAt: r.source_exported_at,
        });
      }

      for (const c of caches) {
        const existing = existingBySourceId.get(c.sourceId);

        // Staleness decision:
        //   * No existing row → new (insert).
        //   * Existing row has no exportedAt or incoming has no
        //     exportedAt → update (we have no way to compare ages;
        //     fall back to "incoming wins" to preserve pre-PR2
        //     behaviour).
        //   * Incoming exportedAt < existing exportedAt → stale (skip).
        //     Equal exportedAt counts as "update" — re-running the
        //     same PQ should be a no-op data-wise but refresh
        //     `last_seen_at`.
        const isStale =
          existing !== undefined &&
          existing.exportedAt !== null &&
          exportedAt !== null &&
          exportedAt < existing.exportedAt;

        if (isStale) {
          cacheIdByCode.set(c.code, existing.id);
          outcome.set(c.code, "stale");
          continue;
        }

        const isNew = existing === undefined;
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
            disabled: c.disabled,
            source_exported_at: exportedAt,
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
                disabled: (eb) => eb.ref("excluded.disabled"),
                source_exported_at: (eb) => eb.ref("excluded.source_exported_at"),
                last_seen_at: sql<Date>`now()`,
              }),
          )
          .returning("id")
          .executeTakeFirstOrThrow();

        cacheIdByCode.set(c.code, Number(row.id));
        outcome.set(c.code, isNew ? "new" : "updated");
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

      return { insertedOrUpdated, waypointsInserted, cacheIdByCode, outcome };
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

  /**
   * Insert a new upload row in the `received` state — before parsing, so
   * the row exists when we write the raw file (which uses the row id as
   * filename). The parse path then transitions the row to `parsed` or
   * `failed` via the dedicated helpers below.
   */
  async insertReceivedUpload(
    ownerId: string,
    filename: string,
  ): Promise<string> {
    const row = await this.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename,
        parsed_count: 0,
        status: "received",
        error: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Record the raw-file metadata once the gzipped XML is on disk. */
  markRawStored(
    uploadId: string,
    sizeBytes: number,
    sha256: string,
  ): Promise<void> {
    return this.db
      .updateTable("gpx_uploads")
      .set({
        raw_size_bytes: BigInt(sizeBytes),
        raw_sha256: sha256,
      })
      .where("id", "=", uploadId)
      .execute()
      .then(() => undefined);
  }

  /**
   * Transition `received` → `parsed` with the final caches-upserted
   * count + the PQ's `<gpx><time>` (FR-I10). `exportedAt` is `null`
   * when the GPX had no top-level time element.
   */
  markParsed(
    uploadId: string,
    parsedCount: number,
    exportedAt: Date | null,
  ): Promise<void> {
    return this.db
      .updateTable("gpx_uploads")
      .set({
        status: "parsed",
        parsed_count: parsedCount,
        error: null,
        exported_at: exportedAt,
      })
      .where("id", "=", uploadId)
      .execute()
      .then(() => undefined);
  }

  /**
   * Transition to `failed` with the parser's error message. We keep the
   * raw file on disk so a future parser fix can be re-applied via the
   * reprocess endpoint without asking the user to re-upload.
   */
  markFailed(uploadId: string, error: string): Promise<void> {
    return this.db
      .updateTable("gpx_uploads")
      .set({
        status: "failed",
        error,
      })
      .where("id", "=", uploadId)
      .execute()
      .then(() => undefined);
  }

  /**
   * Look up an upload's owner + raw-storage metadata for the reprocess
   * path. Returns `null` if the upload doesn't exist for this owner —
   * intentionally indistinguishable from "exists but belongs to someone
   * else" so a cross-tenant id probe leaks no information.
   */
  async findUploadByOwner(
    uploadId: string,
    ownerId: string,
  ): Promise<{
    id: string;
    filename: string;
    rawSizeBytes: bigint | null;
    rawSha256: string | null;
  } | null> {
    const row = await this.db
      .selectFrom("gpx_uploads")
      .select(["id", "filename", "raw_size_bytes", "raw_sha256"])
      .where("id", "=", uploadId)
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      filename: row.filename,
      rawSizeBytes: row.raw_size_bytes,
      rawSha256: row.raw_sha256,
    };
  }
}
