// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Geo, Landuse } from "@gctp/shared";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

interface LanduseRow {
  osm_id: string;
  osm_type: string;
  kind: string;
  geojson: string;
}

/**
 * Read-side repository for landuse polygons (ADR-0009).
 *
 * Writes happen out-of-band via osm2pgsql (one-shot import + daily
 * replication via osm2pgsql-replication). This class does NOT write to
 * landuse_polygons — only the metadata table, and only via the
 * landuse-replication job.
 */
@Injectable()
export class LanduseRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Return all polygons intersecting the requested bbox, optionally
   * filtered by kind. Uses the GIST index on `geom`.
   */
  async findFeatures(
    bbox: Geo.BoundingBox,
    kinds: readonly Landuse.LanduseKind[] | undefined,
  ): Promise<Landuse.LanduseFeature[]> {
    let q = this.db
      .selectFrom("landuse_polygons")
      .select([
        "osm_id",
        "osm_type",
        "kind",
        sql<string>`ST_AsGeoJSON(geom)`.as("geojson"),
      ])
      .where(
        sql<boolean>`geom && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`,
      );
    if (kinds && kinds.length > 0) {
      q = q.where("kind", "in", kinds as unknown as string[]);
    }
    const rows = (await q.execute()) as unknown as LanduseRow[];

    // Use osm_id as the user-visible numeric id; pair with osm_type if a
    // caller ever needs to distinguish way vs relation. Most callers only
    // need geometry + kind, which is what the LanduseFeature shape exposes.
    return rows.map<Landuse.LanduseFeature>((r) => ({
      type: "Feature",
      properties: {
        id: Number(r.osm_id),
        kind: r.kind as Landuse.LanduseKind,
      },
      // osm2pgsql stores everything as MultiPolygon — ST_AsGeoJSON returns
      // a MultiPolygon shape. Cast to the union so the shared LanduseFeature
      // schema accepts it.
      geometry: JSON.parse(r.geojson) as Geo.GeoJsonAnyPolygon,
    }));
  }

  /**
   * Read the single landuse_import_meta row. Returns null before the
   * first import completes.
   */
  async lastImportMeta(): Promise<{
    importedAt: Date;
    pbfTimestamp: Date | null;
    sourceFile: string | null;
    replicatedAt: Date | null;
    replicationState: string | null;
  } | null> {
    const row = await this.db
      .selectFrom("landuse_import_meta")
      .select([
        "imported_at",
        "pbf_timestamp",
        "source_file",
        "replicated_at",
        "replication_state",
      ])
      .where("id", "=", 1)
      .executeTakeFirst();
    if (!row) return null;
    return {
      importedAt: row.imported_at,
      pbfTimestamp: row.pbf_timestamp,
      sourceFile: row.source_file,
      replicatedAt: row.replicated_at,
      replicationState: row.replication_state,
    };
  }

  /**
   * Mark a successful replication update. Called by the
   * landuse-replication BullMQ processor (M4-β follow-up).
   * `state` is 'ok' for success or 'error: <message>' for failure.
   */
  async recordReplication(state: string): Promise<void> {
    await this.db
      .updateTable("landuse_import_meta")
      .set({
        replicated_at: new Date(),
        replication_state: state,
      })
      .where("id", "=", 1)
      .execute();
  }
}
