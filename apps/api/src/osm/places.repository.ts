// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

/** A city/town is recognisable from further away than a hamlet, so each tier
 *  gets its own cap. Tunable; see ADR-0036. */
const MAJOR_KINDS = ["city", "town"] as const;
const MAJOR_CAP_M = 8_000;
const MINOR_KINDS = ["village", "hamlet", "suburb"] as const;
const MINOR_CAP_M = 4_000;

/** Landuse kinds worth naming a tour after when it sits inside one. */
const NAMED_AREA_KINDS = ["park", "forest"] as const;

/**
 * Resolves a human "place" label for a tour from the OSM data the osm2pgsql pass
 * imports (`place_points` settlement nodes + named `landuse_polygons`), ADR-0036.
 * Read-only; mirrors the geography-distance + bbox-prefilter pattern in
 * {@link ParkingFacilitiesRepository}. Best-effort — the caller treats any
 * failure as "no label".
 */
@Injectable()
export class PlacesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * The most recognisable place name for a point (a tour's start anchor):
   *  1. a *named* park / forest the point falls **inside** (smallest, i.e. most
   *     specific, wins) — "Bospark", "de Veluwe";
   *  2. else the nearest meaningful **settlement** — a city/town within 8 km,
   *     else a village/hamlet/suburb within 4 km — "Wageningen";
   *  3. else `null`.
   */
  async resolvePlaceLabel(lng: number, lat: number): Promise<string | null> {
    return (
      (await this.namedAreaContaining(lng, lat)) ??
      (await this.nearestPlace(lng, lat, MAJOR_KINDS, MAJOR_CAP_M)) ??
      (await this.nearestPlace(lng, lat, MINOR_KINDS, MINOR_CAP_M))
    );
  }

  private point(lng: number, lat: number) {
    return sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`;
  }

  /** The smallest named park/forest the point is inside, or null. */
  private async namedAreaContaining(
    lng: number,
    lat: number,
  ): Promise<string | null> {
    const pt = this.point(lng, lat);
    const r = await sql<{ name: string }>`
      SELECT name
      FROM landuse_polygons
      WHERE name IS NOT NULL
        AND kind = ANY(${sql.val(NAMED_AREA_KINDS as readonly string[])}::text[])
        AND geom && ${pt}
        AND ST_Contains(geom, ${pt})
      ORDER BY ST_Area(geom) ASC
      LIMIT 1
    `.execute(this.db);
    return r.rows[0]?.name ?? null;
  }

  /** Nearest settlement of the given kinds within `capM` metres, or null.
   *  KNN-orders on the GIST index; the geography ST_Distance enforces the cap. */
  private async nearestPlace(
    lng: number,
    lat: number,
    kinds: readonly string[],
    capM: number,
  ): Promise<string | null> {
    const pt = this.point(lng, lat);
    const r = await sql<{ name: string }>`
      SELECT name
      FROM place_points
      WHERE place = ANY(${sql.val(kinds as string[])}::text[])
        AND geom && ST_Expand(${pt}, ${capM / 111_000})
        AND ST_Distance(geom::geography, ${pt}::geography) <= ${capM}
      ORDER BY geom <-> ${pt}
      LIMIT 1
    `.execute(this.db);
    return r.rows[0]?.name ?? null;
  }
}
