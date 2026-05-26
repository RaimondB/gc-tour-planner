// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database, PrecomputeKind, PrecomputeState } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export interface StateRow {
  cacheId: number;
  kind: PrecomputeKind;
  state: PrecomputeState | null;
  osrmVersion: string | null;
  fetchedAt: Date | null;
  errorText: string | null;
  missing: boolean;
}

export interface CountsByState {
  fresh: number;
  stale: number;
  failed: number;
  in_progress: number;
  pending: number;
  missing: number;
}

/**
 * Single-source-of-truth definition of "stale" for a given (kind, version,
 * TTL). Used by the admin summary, the stale-list endpoint, and the
 * retrigger-stale enqueue path. Centralizing here means a behaviour change
 * (e.g. new TTL semantics) lands in exactly one place.
 *
 * The SQL classifies each row into one bucket:
 *   - 'fresh'       : state='fresh' AND osrm_version matches AND within TTL
 *   - 'failed'      : state='failed'
 *   - 'in_progress' : state='in_progress'
 *   - 'pending'     : state='pending'
 *   - 'missing'     : no row exists (left-join produced NULL)
 *   - 'stale'       : everything else under state='fresh' that fell out of
 *                     the freshness window (osrm_version mismatch OR fetched_at
 *                     older than TTL)
 *
 * 'stale' implicitly includes 'failed', 'pending', 'in_progress', and
 * 'missing' — those are all caches that need (re-)precompute. The bucket
 * breakdown is exposed separately so operators can tell *why* a cache is
 * stale (in-progress is benign, failed needs attention, missing means
 * upload didn't fire the job).
 */
@Injectable()
export class PrecomputeStateRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Bulk-mark a set of caches as `state` for the given kind. UPSERTs so a
   * fresh row is created if missing. `errorText` only meaningful for
   * `state='failed'`; pass null otherwise.
   */
  async markBulk(
    cacheIds: readonly number[],
    kind: PrecomputeKind,
    state: PrecomputeState,
    opts: { osrmVersion?: string | null; errorText?: string | null } = {},
  ): Promise<void> {
    if (cacheIds.length === 0) return;
    // Chunk to stay comfortably below the 65 535 bind-param cap. With 5 cols
    // per row, 10k rows ≈ 50k params.
    const CHUNK = 10_000;
    const setFreshAt = state === "fresh";
    for (let i = 0; i < cacheIds.length; i += CHUNK) {
      const slice = cacheIds.slice(i, i + CHUNK);
      await this.db
        .insertInto("cache_precompute_state")
        .values(
          slice.map((cacheId) => ({
            cache_id: cacheId,
            kind,
            state,
            osrm_version: opts.osrmVersion ?? null,
            // Only stamp fetched_at on successful runs. Pending/in_progress
            // would mislead future "how old is the data" reads.
            fetched_at: setFreshAt ? new Date() : null,
            error_text: opts.errorText ?? null,
            updated_at: new Date(),
          })),
        )
        .onConflict((oc) =>
          oc.columns(["cache_id", "kind"]).doUpdateSet({
            state: (eb) => eb.ref("excluded.state"),
            // Don't clobber a successful fetched_at with NULL when transitioning
            // through pending/in_progress; only update it on success.
            ...(setFreshAt
              ? { fetched_at: (eb) => eb.ref("excluded.fetched_at") }
              : {}),
            osrm_version: (eb) => eb.ref("excluded.osrm_version"),
            error_text: (eb) => eb.ref("excluded.error_text"),
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    }
  }

  /**
   * Per-(kind) count breakdown across the whole DB, classified by the
   * stale rules above. Used by `GET /admin/precompute/summary`.
   */
  async summary(args: {
    currentOsrmVersion: string;
    staleTtlDays: number;
  }): Promise<{ walking: CountsByState; landuse: CountsByState }> {
    const rows = await sql<{
      kind: PrecomputeKind;
      bucket: keyof CountsByState;
      n: string;
    }>`
      WITH classified AS (
        SELECT
          v.kind,
          CASE
            WHEN v.missing THEN 'missing'
            WHEN v.state = 'failed'      THEN 'failed'
            WHEN v.state = 'in_progress' THEN 'in_progress'
            WHEN v.state = 'pending'     THEN 'pending'
            WHEN v.kind = 'walking'
              AND v.osrm_version IS DISTINCT FROM ${args.currentOsrmVersion}
              THEN 'stale'
            WHEN v.fetched_at IS NULL THEN 'stale'
            WHEN v.fetched_at < now() - (${args.staleTtlDays}::int || ' days')::interval
              THEN 'stale'
            ELSE 'fresh'
          END AS bucket
        FROM v_cache_precompute_state v
      )
      SELECT kind, bucket, COUNT(*)::text AS n
        FROM classified
       GROUP BY 1, 2
    `.execute(this.db);

    const empty = (): CountsByState => ({
      fresh: 0,
      stale: 0,
      failed: 0,
      in_progress: 0,
      pending: 0,
      missing: 0,
    });
    const out = { walking: empty(), landuse: empty() };
    for (const r of rows.rows) {
      out[r.kind][r.bucket] = Number(r.n);
    }
    return out;
  }

  /**
   * Paginated list of caches in the "needs precompute" set — everything not
   * classified as `fresh`. Includes failed / pending / in_progress / missing
   * so the operator can act on each. `total` is the full count irrespective
   * of `limit`.
   */
  async listStale(args: {
    kind: PrecomputeKind;
    currentOsrmVersion: string;
    staleTtlDays: number;
    limit: number;
    offset: number;
  }): Promise<{ entries: StateRow[]; total: number }> {
    const wherePred = sql<boolean>`
      v.kind = ${args.kind}
      AND (
        v.missing
        OR v.state IN ('failed','pending','in_progress')
        OR (v.kind = 'walking'
            AND v.osrm_version IS DISTINCT FROM ${args.currentOsrmVersion})
        OR v.fetched_at IS NULL
        OR v.fetched_at < now() - (${args.staleTtlDays}::int || ' days')::interval
      )
    `;
    const [list, count] = await Promise.all([
      sql<{
        cache_id: string;
        kind: PrecomputeKind;
        state: PrecomputeState | null;
        osrm_version: string | null;
        fetched_at: Date | null;
        error_text: string | null;
        missing: boolean;
      }>`
        SELECT v.cache_id, v.kind, v.state, v.osrm_version, v.fetched_at,
               v.error_text, v.missing
          FROM v_cache_precompute_state v
         WHERE ${wherePred}
         ORDER BY v.cache_id
         LIMIT ${args.limit} OFFSET ${args.offset}
      `.execute(this.db),
      sql<{ n: string }>`
        SELECT COUNT(*)::text AS n
          FROM v_cache_precompute_state v
         WHERE ${wherePred}
      `.execute(this.db),
    ]);

    return {
      entries: list.rows.map((r) => ({
        cacheId: Number(r.cache_id),
        kind: r.kind,
        state: r.state,
        osrmVersion: r.osrm_version,
        fetchedAt: r.fetched_at,
        errorText: r.error_text,
        missing: r.missing,
      })),
      total: Number(count.rows[0]?.n ?? 0),
    };
  }

  /**
   * Cache IDs flagged stale for the given kind, capped at `limit`. Used by
   * the retrigger-stale endpoint to know what to enqueue. Order is stable
   * (by id) so retries pick up where the previous batch left off.
   */
  async staleCacheIds(args: {
    kind: PrecomputeKind;
    currentOsrmVersion: string;
    staleTtlDays: number;
    limit: number;
  }): Promise<number[]> {
    const rows = await sql<{ cache_id: string }>`
      SELECT v.cache_id
        FROM v_cache_precompute_state v
       WHERE v.kind = ${args.kind}
         AND (
           v.missing
           OR v.state IN ('failed','pending','in_progress')
           OR (v.kind = 'walking'
               AND v.osrm_version IS DISTINCT FROM ${args.currentOsrmVersion})
           OR v.fetched_at IS NULL
           OR v.fetched_at < now() - (${args.staleTtlDays}::int || ' days')::interval
         )
       ORDER BY v.cache_id
       LIMIT ${args.limit}
    `.execute(this.db);
    return rows.rows.map((r) => Number(r.cache_id));
  }
}
