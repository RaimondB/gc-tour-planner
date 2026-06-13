// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { ParsedCache, ParsedWaypoint } from "@gctp/shared/gpx";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export type CacheUpsertOutcome = "new" | "updated" | "stale";

/**
 * Cheap equirectangular distance in metres between two lng/lat points. Used
 * only to decide "did this cache's stored coordinate move?" (threshold ~1 m),
 * where the small-angle approximation is more than precise enough — we're not
 * routing, just gating precompute invalidation.
 */
function movedMeters(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
): number {
  const R = 6_371_000;
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180) * Math.cos(meanLat);
  return Math.hypot(dLat, dLng) * R;
}

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
  /**
   * Ids of *existing* caches whose stored `location` actually moved in this
   * upload (a solved upload writing corrected coords, or a normal PQ that
   * shifted a non-solved cache). Their `route_legs` + `cache_landuse` rows
   * were invalidated inside the transaction so the precompute re-warm
   * recomputes them — the OSRM precompute skips pairs it thinks are already
   * fresh, so stale legs must be deleted, not merely re-enqueued. New rows
   * are excluded (they have no precompute to invalidate).
   */
  relocatedCacheIds: readonly number[];
}

export interface UpsertFromGpxOptions {
  /**
   * When true, the file's `<wpt>` coords are the user's *solved* (corrected)
   * coordinates — a deliberate assertion (Groundspeak ships no marker). Every
   * cache in the upload is marked `solved` and its `location` set to the
   * corrected coord; the original posted coord is preserved in
   * `published_location` (untouched for existing rows). Bypasses the staleness
   * guard. A normal upload (`markSolved=false`) never writes `location` on an
   * already-solved row, so the two upload modes never clobber each other.
   */
  markSolved?: boolean;
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
    opts: UpsertFromGpxOptions = {},
  ): Promise<UpsertCachesResult> {
    const markSolved = opts.markSolved === true;
    if (caches.length === 0 && waypoints.length === 0) {
      return {
        insertedOrUpdated: 0,
        waypointsInserted: 0,
        cacheIdByCode: new Map(),
        outcome: new Map(),
        relocatedCacheIds: [],
      };
    }

    return this.db.transaction().execute(async (tx) => {
      let insertedOrUpdated = 0;
      const cacheIdByCode = new Map<string, number>();
      const outcome = new Map<string, CacheUpsertOutcome>();
      const relocatedCacheIds: number[] = [];

      // Bulk-fetch existing rows so the staleness guard can be applied
      // per-cache without per-iteration round-trips. Source is always
      // 'gpx' here — different sources (OKAPI, GC.com) get their own
      // upsert paths.
      const incomingCodes = caches.map((c) => c.sourceId);
      const existingRows =
        incomingCodes.length > 0
          ? await tx
              .selectFrom("caches")
              .select((eb) => [
                "id",
                "source_id",
                "source_exported_at",
                "solved",
                sql<number>`ST_X(${eb.ref("location")}::geometry)`.as("lng"),
                sql<number>`ST_Y(${eb.ref("location")}::geometry)`.as("lat"),
              ])
              .where("owner_id", "=", ownerId)
              .where("source", "=", "gpx")
              .where("source_id", "in", incomingCodes)
              .execute()
          : [];
      const existingBySourceId = new Map<
        string,
        {
          id: number;
          exportedAt: Date | null;
          solved: boolean;
          lng: number;
          lat: number;
        }
      >();
      for (const r of existingRows) {
        existingBySourceId.set(r.source_id, {
          id: Number(r.id),
          exportedAt: r.source_exported_at,
          solved: r.solved,
          lng: r.lng,
          lat: r.lat,
        });
      }

      for (const c of caches) {
        const existing = existingBySourceId.get(c.sourceId);
        const isNew = existing === undefined;

        // Staleness decision (FR-I10) applies to normal uploads only. A
        // solved upload is a deliberate coordinate assertion and bypasses
        // the guard — it never refreshes metadata anyway (see below), so a
        // stale solved file can't downgrade fresh data.
        //   * No existing row → new (insert).
        //   * Existing row or incoming has no exportedAt → update (no way to
        //     compare ages; "incoming wins", preserving pre-PR2 behaviour).
        //   * Incoming exportedAt < existing exportedAt → stale (skip).
        //     Equal counts as "update" (refresh last_seen_at).
        const isStale =
          !markSolved &&
          existing !== undefined &&
          existing.exportedAt !== null &&
          exportedAt !== null &&
          exportedAt < existing.exportedAt;

        if (isStale) {
          cacheIdByCode.set(c.code, existing.id);
          outcome.set(c.code, "stale");
          continue;
        }

        // Does this write touch `location`? A normal upload writes the
        // posted coord into `location` UNLESS the existing row is already
        // solved — then `location` holds the user's solved coord and must be
        // preserved (the only clobber-guard). A solved upload always writes
        // `location` (the corrected coord).
        const writesLocation =
          markSolved || !existing || existing.solved !== true;

        const row = markSolved
          ? // Solved upload: set the corrected coord + solved flag. On an
            // existing row we touch ONLY the solved columns + last_seen — we
            // trust the file's coordinate assertion, not its metadata
            // freshness, and we preserve `published_location` (the posted
            // coord, from a prior normal PQ). A new row has no posted coord
            // yet, so `published_location` stays NULL until a later PQ.
            await tx
              .insertInto("caches")
              .values({
                owner_id: ownerId,
                source: "gpx",
                source_id: c.sourceId,
                code: c.code,
                type: c.type,
                name: c.name,
                location: sql<string>`ST_SetSRID(ST_MakePoint(${c.location[0]}, ${c.location[1]}), 4326)::geography`,
                published_location: null,
                solved: true,
                solved_at: sql<Date>`now()`,
                difficulty: c.difficulty,
                terrain: c.terrain,
                size: c.size,
                archived: c.archived,
                disabled: c.disabled,
                source_exported_at: exportedAt,
                description_hints: c.descriptionHints,
                raw: sql<string>`'{}'::jsonb`,
              })
              .onConflict((oc) =>
                oc
                  .columns(["owner_id", "source", "source_id"])
                  .where("owner_id", "is not", null)
                  .doUpdateSet({
                    location: (eb) => eb.ref("excluded.location"),
                    solved: true,
                    // Keep the original solved_at if already solved.
                    solved_at: sql<Date>`COALESCE(caches.solved_at, now())`,
                    last_seen_at: sql<Date>`now()`,
                  }),
              )
              .returning("id")
              .executeTakeFirstOrThrow()
          : // Normal upload: refresh the posted coord + all metadata. Always
            // updates `published_location`; updates `location` only when the
            // row isn't already solved (otherwise the solved coord wins).
            await tx
              .insertInto("caches")
              .values({
                owner_id: ownerId,
                source: "gpx",
                source_id: c.sourceId,
                code: c.code,
                type: c.type,
                name: c.name,
                location: sql<string>`ST_SetSRID(ST_MakePoint(${c.location[0]}, ${c.location[1]}), 4326)::geography`,
                published_location: sql<string>`ST_SetSRID(ST_MakePoint(${c.location[0]}, ${c.location[1]}), 4326)::geography`,
                difficulty: c.difficulty,
                terrain: c.terrain,
                size: c.size,
                archived: c.archived,
                disabled: c.disabled,
                source_exported_at: exportedAt,
                // FR-SF8: persist the parser's multilingual tool-keyword
                // scan. Always non-null on the write path so we can tell
                // "scanned, no matches" (`[]`) apart from "never scanned"
                // (`NULL`, pre-PR3 rows) later when back-filling.
                description_hints: c.descriptionHints,
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
                    // Preserve a solved cache's corrected `location`; only
                    // refresh it for non-solved rows.
                    ...(writesLocation
                      ? { location: (eb) => eb.ref("excluded.location") }
                      : {}),
                    published_location: (eb) =>
                      eb.ref("excluded.published_location"),
                    difficulty: (eb) => eb.ref("excluded.difficulty"),
                    terrain: (eb) => eb.ref("excluded.terrain"),
                    size: (eb) => eb.ref("excluded.size"),
                    archived: (eb) => eb.ref("excluded.archived"),
                    disabled: (eb) => eb.ref("excluded.disabled"),
                    source_exported_at: (eb) =>
                      eb.ref("excluded.source_exported_at"),
                    description_hints: (eb) =>
                      eb.ref("excluded.description_hints"),
                    last_seen_at: sql<Date>`now()`,
                  }),
              )
              .returning("id")
              .executeTakeFirstOrThrow();

        cacheIdByCode.set(c.code, Number(row.id));
        outcome.set(c.code, isNew ? "new" : "updated");
        insertedOrUpdated += 1;

        // Relocation: an existing row whose stored `location` actually moved
        // (corrected coord differs from the old one) has stale precompute.
        // New rows are excluded (no legs/landuse to invalidate yet).
        if (
          existing &&
          writesLocation &&
          movedMeters(
            existing.lng,
            existing.lat,
            c.location[0],
            c.location[1],
          ) > 1
        ) {
          relocatedCacheIds.push(existing.id);
        }

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

      // Invalidate location-derived precompute for relocated caches. The
      // walking-precompute job skips OSRM pairs it thinks are already fresh,
      // so a moved cache's stale `route_legs` must be deleted to force a
      // refetch; `cache_landuse` membership is recomputed by the same job's
      // bbox populate once the stale rows are gone. The precompute re-warm is
      // enqueued by the service for every cache in the upload, so the moved
      // caches are back in scope.
      if (relocatedCacheIds.length > 0) {
        await tx
          .deleteFrom("route_legs")
          .where((eb) =>
            eb.or([
              eb("from_cache_id", "in", relocatedCacheIds),
              eb("to_cache_id", "in", relocatedCacheIds),
            ]),
          )
          .execute();
        await tx
          .deleteFrom("cache_landuse")
          .where("cache_id", "in", relocatedCacheIds)
          .execute();
        // Reset the landuse scan stamp so the re-warm populate re-scans these
        // moved caches (their old membership was just deleted; 1779720000000).
        await tx
          .updateTable("caches")
          .set({ landuse_scanned_at: null })
          .where("id", "in", relocatedCacheIds)
          .execute();
      }

      return {
        insertedOrUpdated,
        waypointsInserted,
        cacheIdByCode,
        outcome,
        relocatedCacheIds,
      };
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
   * FR-I12 dedup lookup: the most recent *successfully parsed* upload by
   * this owner whose raw bytes hash to `sha256`. Used to skip re-storing +
   * re-processing a byte-identical re-upload. Scoped to `owner_id` (the
   * per-user isolation rule), matches only `status = 'parsed'` (a prior
   * failed/partial upload should not suppress a retry), and ignores rows
   * with a NULL `raw_sha256` (predate raw storage). `gpx_uploads` stays
   * tiny (< 1k rows lifetime) so no dedicated index is warranted.
   */
  async findParsedUploadByHash(
    ownerId: string,
    sha256: string,
  ): Promise<{ id: string; exportedAt: Date | null } | null> {
    const row = await this.db
      .selectFrom("gpx_uploads")
      .select(["id", "exported_at"])
      .where("owner_id", "=", ownerId)
      .where("raw_sha256", "=", sha256)
      .where("status", "=", "parsed")
      .orderBy("uploaded_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return { id: row.id, exportedAt: row.exported_at };
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
