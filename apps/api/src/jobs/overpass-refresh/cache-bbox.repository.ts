// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Geo } from "@gctp/shared";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../../database/database.tokens.js";

/**
 * Returns the bounding box around a set of caches, plus a buffer in metres
 * (converted to a geography buffer so the unit comes out right). Used by
 * the `overpass-refresh` processor to know which landuse cells to warm.
 */
@Injectable()
export class CacheBboxRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Bounding box of `cacheIds` (owned by `ownerId`), expanded by `bufferM`
   * metres on every side. Returns `null` if no rows match (caller should
   * skip — there's nothing to refresh).
   *
   * Implementation: `ST_Extent` on the geometry projection of the buffered
   * geographies. We round-trip through ::geography → ST_Buffer → ::geometry
   * so the buffer is real metres, not degrees.
   */
  async bboxAround(
    ownerId: string,
    cacheIds: readonly number[],
    bufferM: number,
  ): Promise<Geo.BoundingBox | null> {
    if (cacheIds.length === 0) return null;
    const rows = await sql<{
      min_lng: number | null;
      min_lat: number | null;
      max_lng: number | null;
      max_lat: number | null;
    }>`
      SELECT
        ST_XMin(ext)::float8 AS min_lng,
        ST_YMin(ext)::float8 AS min_lat,
        ST_XMax(ext)::float8 AS max_lng,
        ST_YMax(ext)::float8 AS max_lat
      FROM (
        SELECT ST_Extent(ST_Buffer(location, ${bufferM})::geometry) AS ext
          FROM caches
         WHERE owner_id = ${ownerId}
           AND id IN (${sql.join(cacheIds)})
      ) sub
    `.execute(this.db);

    const r = rows.rows[0];
    if (
      !r ||
      r.min_lng === null ||
      r.min_lat === null ||
      r.max_lng === null ||
      r.max_lat === null
    ) {
      return null;
    }
    return {
      minLng: r.min_lng,
      minLat: r.min_lat,
      maxLng: r.max_lng,
      maxLat: r.max_lat,
    };
  }
}
