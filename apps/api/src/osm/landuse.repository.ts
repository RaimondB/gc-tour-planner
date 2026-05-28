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
   *
   * Level-of-detail: at large bboxes the response would otherwise be
   * tens of thousands of polygons + tens of MB of JSON (NL has ~32
   * landuse polygons/km², ~1.3 M in total). Two PostGIS-side reductions
   * scale with the requested bbox:
   *
   *   * `ST_SimplifyPreserveTopology(geom, tolerance)` — drop coordinate
   *     pairs that are within `tolerance` degrees of a straight line.
   *     Tolerance scales with bbox width: ~bbox_width / 1000, so at a
   *     1024-px-wide map render each surviving vertex is ≥ ~1 px apart.
   *   * Area filter — drop polygons whose bounding-box area is smaller
   *     than ~(tolerance × 4)² sq-degrees, i.e. they'd be < 4×4 px at
   *     this zoom and aren't visible anyway. Uses an envelope check
   *     instead of ST_Area so the GIST index still helps.
   *
   * Both kick in continuously; at a small zoomed-in bbox the tolerance
   * is sub-meter and the area floor is below any real polygon, so the
   * detail you see when panned in is unaffected.
   */
  async findFeatures(
    bbox: Geo.BoundingBox,
    kinds: readonly Landuse.LanduseKind[] | undefined,
  ): Promise<Landuse.LanduseFeature[]> {
    const widthDeg = Math.max(
      bbox.maxLng - bbox.minLng,
      bbox.maxLat - bbox.minLat,
    );
    // ~1 px equivalent on a 1024-px wide rendered map.
    const toleranceDeg = widthDeg / 1024;
    // Envelope-side floor for "is this polygon visible at this zoom?".
    // ~2 px on each axis. Combined with OR (not AND) below, this keeps
    // long-thin features like rivers / industrial strips even when one
    // axis is sub-pixel, while still dropping the truly-tiny-dot
    // polygons that bloat the payload at country zoom.
    const minEnvSide = toleranceDeg * 2;

    let q = this.db
      .selectFrom("landuse_polygons")
      .select([
        "osm_id",
        "osm_type",
        "kind",
        sql<string>`ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, ${toleranceDeg}))`.as(
          "geojson",
        ),
      ])
      .where(
        sql<boolean>`geom && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`,
      )
      // Drop polygons too small to render at this zoom. AND-rule (both
      // axes must clear the floor) keeps the response bounded — OR was
      // briefly tried but let through enough polygons at province-wide
      // zoom to OOM the Node heap. The multiplier was lowered from 4
      // to 2 in the same change so rural fragmented landuse (small
      // parks / forest patches in the 350–700 m range) survives at
      // region zoom; that's the readability win we wanted.
      .where(
        sql<boolean>`(ST_XMax(geom) - ST_XMin(geom)) > ${minEnvSide}
                     AND (ST_YMax(geom) - ST_YMin(geom)) > ${minEnvSide}`,
      );
    if (kinds && kinds.length > 0) {
      q = q.where("kind", "in", kinds as unknown as string[]);
    }
    // Hard ceiling on response size. Even at very low zoom (~province
    // wide, post-LOD) we should never ship more than this — a runaway
    // result set previously crashed the Node heap with OOM. Order by
    // envelope area DESC so the *biggest* polygons land first;
    // truncation drops invisible-grade dots rather than headline
    // features.
    const MAX_FEATURES = 5_000;
    q = q
      .orderBy(
        sql`(ST_XMax(geom) - ST_XMin(geom)) * (ST_YMax(geom) - ST_YMin(geom))`,
        "desc",
      )
      .limit(MAX_FEATURES);
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
