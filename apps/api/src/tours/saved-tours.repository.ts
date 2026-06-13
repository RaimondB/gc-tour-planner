// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Tours } from "@gctp/shared";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

/**
 * The derived row a saved tour persists. The service builds this from the
 * client's PlanResult (typed columns are derived, never trusted from the
 * wire); the repository just maps it to SQL.
 */
export interface SaveTourRow {
  ownerId: string;
  name: string;
  startPoint: { lng: number; lat: number };
  parkingPoint: { lng: number; lat: number } | null;
  cacheIds: number[];
  totalMeters: number;
  totalSeconds: number;
  /** GeoJSON LineString geometry of the routed loop. */
  geom: unknown;
  scoreBreakdown: Record<string, number>;
  /** Full StoredPlan (PlanResult + cache snapshot). */
  plan: Tours.StoredPlan;
}

/** Lean row for the list endpoint. */
export interface TourSummaryRow {
  id: string;
  name: string;
  total_meters: string;
  total_seconds: string;
  cache_count: number;
  is_shared: boolean;
  created_at: Date;
}

/** Full row for detail / just-saved responses. */
export interface TourDetailRow extends TourSummaryRow {
  /** GeoJSON string from ST_AsGeoJSON. */
  start_geojson: string;
  parking_geojson: string | null;
  /** Parsed JSONB — validated by the service against StoredPlan. */
  plan: unknown;
}

const SUMMARY_COLUMNS = sql`
  id,
  name,
  total_meters,
  total_seconds,
  cardinality(cache_ids)::int AS cache_count,
  (share_slug IS NOT NULL) AS is_shared,
  created_at
`;

/**
 * Persistence for saved tours (M6-γ). Every method is owner-scoped — a
 * cross-tenant id reads/writes nothing, so the service surfaces it as 404
 * (FR-P2.2, indistinguishable from "does not exist").
 */
@Injectable()
export class SavedToursRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async save(row: SaveTourRow): Promise<TourDetailRow> {
    const start = sql`ST_SetSRID(ST_MakePoint(${row.startPoint.lng}, ${row.startPoint.lat}), 4326)::geography`;
    const parking = row.parkingPoint
      ? sql`ST_SetSRID(ST_MakePoint(${row.parkingPoint.lng}, ${row.parkingPoint.lat}), 4326)::geography`
      : sql`NULL`;
    const geom = sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.geom)}), 4326)::geography`;

    const inserted = await sql<TourDetailRow>`
      INSERT INTO tours (
        owner_id, name, start_point, parking_point, cache_ids,
        total_meters, total_seconds, geom, score_breakdown, plan
      ) VALUES (
        ${row.ownerId},
        ${row.name},
        ${start},
        ${parking},
        ${sql.val(row.cacheIds)}::bigint[],
        ${row.totalMeters},
        ${row.totalSeconds},
        ${geom},
        ${JSON.stringify(row.scoreBreakdown)}::jsonb,
        ${JSON.stringify(row.plan)}::jsonb
      )
      RETURNING
        id, name, total_meters, total_seconds,
        cardinality(cache_ids)::int AS cache_count,
        (share_slug IS NOT NULL) AS is_shared,
        created_at,
        ST_AsGeoJSON(start_point) AS start_geojson,
        ST_AsGeoJSON(parking_point) AS parking_geojson,
        plan
    `.execute(this.db);

    return inserted.rows[0]!;
  }

  async list(ownerId: string): Promise<TourSummaryRow[]> {
    const result = await sql<TourSummaryRow>`
      SELECT ${SUMMARY_COLUMNS}
      FROM tours
      WHERE owner_id = ${ownerId}
      ORDER BY created_at DESC
    `.execute(this.db);
    return result.rows;
  }

  async findById(ownerId: string, id: string): Promise<TourDetailRow | null> {
    const result = await sql<TourDetailRow>`
      SELECT
        id, name, total_meters, total_seconds,
        cardinality(cache_ids)::int AS cache_count,
        (share_slug IS NOT NULL) AS is_shared,
        created_at,
        ST_AsGeoJSON(start_point) AS start_geojson,
        ST_AsGeoJSON(parking_point) AS parking_geojson,
        plan
      FROM tours
      WHERE owner_id = ${ownerId} AND id = ${id}
    `.execute(this.db);
    return result.rows[0] ?? null;
  }

  /** Rename in place; returns the updated detail row, or null cross-tenant. */
  async rename(
    ownerId: string,
    id: string,
    name: string,
  ): Promise<TourDetailRow | null> {
    const result = await sql<TourDetailRow>`
      UPDATE tours
      SET name = ${name}
      WHERE owner_id = ${ownerId} AND id = ${id}
      RETURNING
        id, name, total_meters, total_seconds,
        cardinality(cache_ids)::int AS cache_count,
        (share_slug IS NOT NULL) AS is_shared,
        created_at,
        ST_AsGeoJSON(start_point) AS start_geojson,
        ST_AsGeoJSON(parking_point) AS parking_geojson,
        plan
    `.execute(this.db);
    return result.rows[0] ?? null;
  }

  /** Delete (CASCADE-free); returns true when a row was actually removed. */
  async delete(ownerId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("tours")
      .where("owner_id", "=", ownerId)
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    return !!result;
  }
}
