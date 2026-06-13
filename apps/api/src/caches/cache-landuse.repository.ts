// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

/**
 * Per-cache landuse-kind membership (ADR-0009): which canonical kinds of
 * `landuse_polygons` contain a given cache. Used by Pass 1 cluster scoring
 * (`cluster-scoring.ts`) to compute the `landuseMatch` term — "what
 * fraction of this cluster's caches sit inside any polygon whose kind
 * matches the user's landuse profile?".
 *
 * Storage strategy: lazy-populate per bbox on first plan that touches a
 * region. The `populate_cache_landuse_in_bbox` SQL function is idempotent
 * (ON CONFLICT DO NOTHING) AND scan-once: it only scans caches whose
 * `caches.landuse_scanned_at` is NULL, stamping them afterwards, so calling it
 * repeatedly on an already-scanned region is a near-instant no-op instead of
 * re-running the caches × landuse_polygons spatial join (migration
 * 1779720000000 — it dominated Pass-1 discovery latency). PK is (cache_id,
 * kind) so a cache inside three forest polygons gets ONE forest row, not three.
 */
@Injectable()
export class CacheLanduseRepository {
  private readonly logger = new Logger(CacheLanduseRepository.name);

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Populate the cache_landuse join for every (cache, landuse) pair where the
   * cache lies inside a polygon and both sit inside `bbox`. Returns the number
   * of new rows inserted (existing rows are not double-counted).
   *
   * Idempotent: a region planned twice does not double-write. Assumes
   * `landuse_polygons` has been populated for the region — the
   * osm2pgsql-import compose service (ADR-0009) runs once at first boot.
   */
  async populateForBbox(
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
  ): Promise<number> {
    const row = (await sql<{
      populate_cache_landuse_in_bbox: string;
    }>`SELECT populate_cache_landuse_in_bbox(${minLng}, ${minLat}, ${maxLng}, ${maxLat})`.execute(
      this.db,
    )) as unknown as {
      rows: Array<{ populate_cache_landuse_in_bbox: string | number }>;
    };
    const inserted = Number(row.rows[0]?.populate_cache_landuse_in_bbox ?? 0);
    if (inserted > 0) {
      this.logger.debug(
        `cache_landuse: inserted ${inserted} rows for bbox [${minLng},${minLat}]→[${maxLng},${maxLat}]`,
      );
    }
    return inserted;
  }

  /**
   * For each cache id, return the distinct set of landuse kinds it sits inside.
   * Returns an empty array for caches with no recorded landuse membership.
   * Caller MUST ensure `populateForBbox` has run for the relevant region first
   * — this is a pure lookup, not lazy.
   */
  async kindsByCacheId(
    cacheIds: readonly number[],
  ): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (cacheIds.length === 0) return out;
    const rows = (await this.db
      .selectFrom("cache_landuse")
      .select(["cache_id", "kind"])
      .where("cache_id", "in", cacheIds as unknown as number[])
      .execute()) as unknown as Array<{ cache_id: string; kind: string }>;
    for (const r of rows) {
      const id = Number(r.cache_id);
      const list = out.get(id);
      if (list) {
        if (!list.includes(r.kind)) list.push(r.kind);
      } else {
        out.set(id, [r.kind]);
      }
    }
    return out;
  }
}
