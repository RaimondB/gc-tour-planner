// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Tours } from "@gctp/shared";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";
import { mintShareSlug } from "./share-slug.js";

/** Postgres unique-violation SQLSTATE — a share-slug collision retries. */
const UNIQUE_VIOLATION = "23505";

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
  has_preview: boolean;
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
  (preview_image IS NOT NULL) AS has_preview,
  created_at
`;

/** Summary columns + the geometry/plan a detail row carries. Reused by every
 *  SELECT/RETURNING that yields a {@link TourDetailRow}. */
const DETAIL_COLUMNS = sql`
  id, name, total_meters, total_seconds,
  cardinality(cache_ids)::int AS cache_count,
  (share_slug IS NOT NULL) AS is_shared,
  (preview_image IS NOT NULL) AS has_preview,
  created_at,
  ST_AsGeoJSON(start_point) AS start_geojson,
  ST_AsGeoJSON(parking_point) AS parking_geojson,
  plan
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
      RETURNING ${DETAIL_COLUMNS}
    `.execute(this.db);

    return inserted.rows[0]!;
  }

  /**
   * Overwrite an existing tour in place (FR-P2.4) — re-planned/edited route.
   * Replaces the typed columns + `plan`, but deliberately leaves `created_at`,
   * `share_slug`, and the stored preview untouched: editing the route keeps the
   * tour's share link live and its thumbnail until a fresh snapshot replaces it.
   * Owner-scoped — returns null cross-tenant (→ service 404).
   */
  async update(
    ownerId: string,
    id: string,
    row: Omit<SaveTourRow, "ownerId">,
  ): Promise<TourDetailRow | null> {
    const start = sql`ST_SetSRID(ST_MakePoint(${row.startPoint.lng}, ${row.startPoint.lat}), 4326)::geography`;
    const parking = row.parkingPoint
      ? sql`ST_SetSRID(ST_MakePoint(${row.parkingPoint.lng}, ${row.parkingPoint.lat}), 4326)::geography`
      : sql`NULL`;
    const geom = sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.geom)}), 4326)::geography`;

    const updated = await sql<TourDetailRow>`
      UPDATE tours SET
        name = ${row.name},
        start_point = ${start},
        parking_point = ${parking},
        cache_ids = ${sql.val(row.cacheIds)}::bigint[],
        total_meters = ${row.totalMeters},
        total_seconds = ${row.totalSeconds},
        geom = ${geom},
        score_breakdown = ${JSON.stringify(row.scoreBreakdown)}::jsonb,
        plan = ${JSON.stringify(row.plan)}::jsonb
      WHERE owner_id = ${ownerId} AND id = ${id}
      RETURNING ${DETAIL_COLUMNS}
    `.execute(this.db);

    return updated.rows[0] ?? null;
  }

  /**
   * Mint (or return the existing) opaque share slug for a tour (FR-P3.1).
   * Idempotent via COALESCE — an already-shared tour keeps its slug. Retries on
   * the rare slug collision with another tour. Null cross-tenant (→ 404).
   */
  async share(ownerId: string, id: string): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = mintShareSlug();
      try {
        const result = await sql<{ share_slug: string | null }>`
          UPDATE tours
          SET share_slug = COALESCE(share_slug, ${candidate})
          WHERE owner_id = ${ownerId} AND id = ${id}
          RETURNING share_slug
        `.execute(this.db);
        const updated = result.rows[0];
        if (!updated) return null; // cross-tenant / missing
        return updated.share_slug; // existing slug, or the one just minted
      } catch (err) {
        // Collided with another tour's slug — only possible when this row's
        // share_slug was NULL (COALESCE kept an existing one unchanged). Retry.
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) continue;
        throw err;
      }
    }
    throw new Error(
      "Could not mint a unique share slug after several attempts",
    );
  }

  /** Revoke a tour's share (FR-P3.4) — nulls the slug. False cross-tenant. */
  async unshare(ownerId: string, id: string): Promise<boolean> {
    const result = await this.db
      .updateTable("tours")
      .set({ share_slug: null })
      .where("owner_id", "=", ownerId)
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    return !!result;
  }

  /**
   * Public slug lookup (FR-P3.2) — **NOT owner-scoped** by design: this backs
   * the anonymous `GET /shared/:slug` read. Returns only the tour name + stored
   * `plan` snapshot; the service projects the safe public subset (ADR-0022).
   */
  async findBySlug(
    slug: string,
  ): Promise<{ name: string; plan: unknown } | null> {
    const row = await this.db
      .selectFrom("tours")
      .select(["name", "plan"])
      .where("share_slug", "=", slug)
      .executeTakeFirst();
    return row ?? null;
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
      SELECT ${DETAIL_COLUMNS}
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
      RETURNING ${DETAIL_COLUMNS}
    `.execute(this.db);
    return result.rows[0] ?? null;
  }

  /**
   * Store (or replace) the map snapshot for a tour. Owner-scoped — returns true
   * only when the caller's own row was updated, so a cross-tenant id is a no-op
   * the service surfaces as 404.
   */
  async savePreview(
    ownerId: string,
    id: string,
    image: Buffer,
    mime: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("tours")
      .set({ preview_image: image, preview_mime: mime })
      .where("owner_id", "=", ownerId)
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    return !!result;
  }

  /** Read a tour's stored snapshot; null cross-tenant or when none captured. */
  async getPreview(
    ownerId: string,
    id: string,
  ): Promise<{ image: Buffer; mime: string } | null> {
    const row = await this.db
      .selectFrom("tours")
      .select(["preview_image", "preview_mime"])
      .where("owner_id", "=", ownerId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row?.preview_image) return null;
    return {
      image: row.preview_image,
      mime: row.preview_mime ?? "application/octet-stream",
    };
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
