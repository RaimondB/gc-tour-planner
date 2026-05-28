// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Geo, ParkingFacilities } from "@gctp/shared";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

interface ParkingRow {
  osm_id: string;
  osm_type: string;
  access: string | null;
  fee: string | null;
  parking_type: string | null;
  capacity: number | null;
  maxstay: string | null;
  supervised: string | null;
  opening_hours: string | null;
  surface: string | null;
  name: string | null;
  geojson: string;
}

export interface ParkingNearCandidate {
  osmId: number;
  osmType: "N" | "W" | "R";
  /** Centroid for nodes = the point; for polygons = ST_Centroid. */
  point: [number, number];
  access: string | null;
  fee: string | null;
  name: string | null;
}

/**
 * Read-side repository for `parking_facilities` (ADR-0011).
 *
 * Writes happen out-of-band via osm2pgsql in the same pass that populates
 * `landuse_polygons` — there is intentionally no write API here.
 */
@Injectable()
export class ParkingFacilitiesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Return every parking facility intersecting the bbox, optionally
   * filtered by access value and fee. Mirrors `LanduseRepository.findFeatures`
   * — same level-of-detail trick so a country-wide bbox doesn't dump
   * tens of MB of polygon JSON on the wire.
   *
   * Point features are exempt from the LOD area floor (they don't have
   * width / height) — they're cheap to ship and useful at any zoom.
   */
  async findFeatures(
    bbox: Geo.BoundingBox,
    filter: {
      access?: readonly string[];
      fee?: ParkingFacilities.ParkingFeeFilter;
    },
  ): Promise<ParkingFacilities.ParkingFacilityFeature[]> {
    const widthDeg = Math.max(
      bbox.maxLng - bbox.minLng,
      bbox.maxLat - bbox.minLat,
    );
    const toleranceDeg = widthDeg / 1024;
    const minEnvSide = toleranceDeg * 4;

    let q = this.db
      .selectFrom("parking_facilities")
      .select([
        "osm_id",
        "osm_type",
        "access",
        "fee",
        "parking_type",
        "capacity",
        "maxstay",
        "supervised",
        "opening_hours",
        "surface",
        "name",
        // Simplify polygons; points pass through unchanged (no-op).
        // Precision 6 = ~10 cm at the equator — well below any rendered
        // pixel at our zooms — and trims the payload size meaningfully
        // (default precision 9 is overkill for an overlay).
        sql<string>`ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, ${toleranceDeg}), 6)`.as(
          "geojson",
        ),
      ])
      .where(
        sql<boolean>`geom && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`,
      )
      // Drop polygons too small to render at this zoom. Points are kept —
      // their envelope is degenerate (width = height = 0) so the polygon
      // floor would unconditionally drop them, hence the OR.
      .where(
        sql<boolean>`(ST_GeometryType(geom) = 'ST_Point')
                     OR ((ST_XMax(geom) - ST_XMin(geom)) > ${minEnvSide}
                         AND (ST_YMax(geom) - ST_YMin(geom)) > ${minEnvSide})`,
      );

    // Unconditional floor: `access=private` parkings are never useful as
    // a tour start. `IS DISTINCT FROM` (not `<>`) keeps NULLs in scope —
    // many OSM parkings omit the access tag entirely.
    q = q.where(sql<boolean>`access IS DISTINCT FROM 'private'`);
    if (filter.access && filter.access.length > 0) {
      q = q.where("access", "in", filter.access as string[]);
    }
    if (filter.fee === "free") {
      q = q.where("fee", "=", "no");
    } else if (filter.fee === "paid") {
      q = q.where("fee", "=", "yes");
    }

    const rows = (await q.execute()) as unknown as ParkingRow[];
    return rows.map<ParkingFacilities.ParkingFacilityFeature>((r) => ({
      type: "Feature",
      properties: {
        osmId: Number(r.osm_id),
        osmType: r.osm_type as "N" | "W" | "R",
        access: r.access,
        fee: r.fee,
        parkingType: r.parking_type,
        capacity: r.capacity,
        maxstay: r.maxstay,
        supervised: r.supervised,
        openingHours: r.opening_hours,
        surface: r.surface,
        name: r.name,
      },
      geometry: JSON.parse(r.geojson) as
        | Geo.GeoJsonPoint
        | Geo.GeoJsonAnyPolygon,
    }));
  }

  /**
   * Planner-side helper: candidate parkings within `radiusM` of `point`,
   * pre-filtered by access + fee. Returns the centroid (or the node
   * point) per candidate so the planner can route OSRM `foot` from it
   * to the cluster's nearest cache. No geometry payload — kept minimal
   * to make this cheap when the planner fans out across many clusters.
   */
  async findNear(
    point: [number, number],
    radiusM: number,
    filter: {
      access?: readonly string[];
      fee?: ParkingFacilities.ParkingFeeFilter;
    },
  ): Promise<ParkingNearCandidate[]> {
    const [lng, lat] = point;
    let q = this.db
      .selectFrom("parking_facilities")
      .select([
        "osm_id",
        "osm_type",
        "access",
        "fee",
        "name",
        // ST_DWithin on geography would force a cast on every row and
        // defeat the GIST index. Instead expand a degree-bounded envelope
        // around the point (cheap, indexable) and do the precise distance
        // check on the much smaller result set.
        sql<number>`ST_X(ST_Centroid(geom))`.as("cx"),
        sql<number>`ST_Y(ST_Centroid(geom))`.as("cy"),
        sql<number>`ST_Distance(ST_Centroid(geom)::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)`.as(
          "dist_m",
        ),
      ])
      // Bounding envelope expansion: meters → degrees rough conversion.
      // 1 degree latitude ≈ 111 km; longitude varies with cos(lat).
      .where(
        sql<boolean>`geom && ST_Expand(
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326),
          ${radiusM / 111_000}
        )`,
      )
      // Exact filter happens via the alias, so we re-apply ST_Distance.
      .where(
        sql<boolean>`ST_Distance(
          ST_Centroid(geom)::geography,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        ) <= ${radiusM}`,
      );

    // Unconditional floor — `access=private` is never a valid planner
    // candidate; see findFeatures for the matching rule.
    q = q.where(sql<boolean>`access IS DISTINCT FROM 'private'`);
    if (filter.access && filter.access.length > 0) {
      q = q.where("access", "in", filter.access as string[]);
    }
    if (filter.fee === "free") {
      q = q.where("fee", "=", "no");
    } else if (filter.fee === "paid") {
      q = q.where("fee", "=", "yes");
    }

    interface NearRow {
      osm_id: string;
      osm_type: string;
      access: string | null;
      fee: string | null;
      name: string | null;
      cx: number;
      cy: number;
      dist_m: number;
    }
    const rows = (await q.execute()) as unknown as NearRow[];
    return rows
      .sort((a, b) => a.dist_m - b.dist_m)
      .map<ParkingNearCandidate>((r) => ({
        osmId: Number(r.osm_id),
        osmType: r.osm_type as "N" | "W" | "R",
        point: [Number(r.cx), Number(r.cy)],
        access: r.access,
        fee: r.fee,
        name: r.name,
      }));
  }
}
