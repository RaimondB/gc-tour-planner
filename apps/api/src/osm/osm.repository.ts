// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Geo, Landuse } from "@gctp/shared";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";
import { STALENESS_MS, type Cell } from "./cells.js";
import type { FetchedLanduse } from "./overpass.client.js";

interface LanduseRow {
  id: string;
  kind: string;
  geojson: string;
}

@Injectable()
export class OsmRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Find cells whose newest row is older than the staleness window (or who
   * have no rows at all). Returns the area hashes that need to be re-fetched
   * from Overpass.
   */
  async stalenessCheck(cells: readonly Cell[]): Promise<string[]> {
    if (cells.length === 0) return [];
    const hashes = cells.map((c) => c.areaHash);
    const rows = await this.db
      .selectFrom("osm_landuse")
      .select((eb) => ["area_hash", eb.fn.max("fetched_at").as("newest")])
      .where("area_hash", "in", hashes)
      .groupBy("area_hash")
      .execute();

    const fresh = new Set<string>();
    const cutoff = Date.now() - STALENESS_MS;
    for (const r of rows) {
      const newest =
        r.newest instanceof Date
          ? r.newest.getTime()
          : Date.parse(String(r.newest));
      if (newest >= cutoff) fresh.add(r.area_hash);
    }
    return hashes.filter((h) => !fresh.has(h));
  }

  /**
   * Replace every row for a cell with the freshly-fetched set. Done in one
   * transaction so a partial failure leaves the previous fresh cache intact
   * — better stale-but-present than empty.
   */
  async replaceCell(
    areaHash: string,
    fetched: readonly FetchedLanduse[],
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom("osm_landuse")
        .where("area_hash", "=", areaHash)
        .execute();
      if (fetched.length === 0) {
        // Insert a sentinel row? No — we rely on (max(fetched_at) per cell).
        // An empty cell has no rows; stalenessCheck above will refetch every
        // call until something arrives. Acceptable: cells with no landuse
        // (open sea, desert) are rare in geocaching territory.
        return;
      }
      await tx
        .insertInto("osm_landuse")
        .values(
          fetched.map((f) => ({
            area_hash: areaHash,
            osm_way_id: f.osmWayId,
            kind: f.kind,
            polygon: sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.polygon)}), 4326)::geography`,
          })),
        )
        .execute();
    });
  }

  /**
   * Return all polygons intersecting the requested bbox, optionally filtered
   * by kind. Results may include polygons fetched in nearby cells that
   * happen to overlap the query bbox.
   */
  async findFeatures(
    bbox: Geo.BoundingBox,
    kinds: readonly Landuse.LanduseKind[] | undefined,
  ): Promise<Landuse.LanduseFeature[]> {
    let q = this.db
      .selectFrom("osm_landuse")
      .select([
        "id",
        "kind",
        sql<string>`ST_AsGeoJSON(polygon::geometry)`.as("geojson"),
      ])
      .where(
        sql<boolean>`polygon::geometry && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`,
      );
    if (kinds && kinds.length > 0) {
      q = q.where("kind", "in", kinds as unknown as string[]);
    }
    const rows = (await q.execute()) as unknown as LanduseRow[];

    return rows.map<Landuse.LanduseFeature>((r) => ({
      type: "Feature",
      properties: { id: Number(r.id), kind: r.kind as Landuse.LanduseKind },
      geometry: JSON.parse(r.geojson) as Geo.GeoJsonPolygon,
    }));
  }
}
