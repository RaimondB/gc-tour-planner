// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../../database/database.tokens.js";

/**
 * One spatial query used by the walking-precompute processor: given the set
 * of newly-uploaded caches, find every existing cache (for the same owner)
 * within `radiusM` of any of them. These are the caches whose top-k walking
 * neighbours may have changed because of the new arrivals — they get
 * recomputed alongside the newcomers.
 *
 * Lives in its own tiny repo rather than CachesRepository because it's
 * processor-private and uses a join shape the caches feature doesn't need.
 */
@Injectable()
export class AffectedSetRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Returns IDs of caches (owned by `ownerId`) that are within `radiusM` of
   * any cache in `newCacheIds`, EXCLUDING the new caches themselves. Empty
   * input → empty output. Distance is on geography (`ST_DWithin` over the
   * GIST index) so units are meters and the great-circle approximation is
   * correct without a separate projection.
   */
  async findAffected(
    ownerId: string,
    newCacheIds: readonly number[],
    radiusM: number,
  ): Promise<number[]> {
    if (newCacheIds.length === 0) return [];
    // The CTE pulls the new caches' geographies; the main SELECT finds every
    // other cache within radiusM of any one of them via ST_DWithin. The
    // ST_DWithin call exists in the WHERE so the GIST index is usable.
    const rows = await sql<{ id: string }>`
      WITH new_caches AS (
        SELECT id, location
          FROM caches
         WHERE owner_id = ${ownerId}
           AND id IN (${sql.join(newCacheIds)})
      )
      SELECT DISTINCT existing.id
        FROM caches existing
        JOIN new_caches nc
          ON ST_DWithin(existing.location, nc.location, ${radiusM})
       WHERE existing.owner_id = ${ownerId}
         AND existing.id NOT IN (${sql.join(newCacheIds)})
    `.execute(this.db);
    return rows.rows.map((r) => Number(r.id));
  }
}
