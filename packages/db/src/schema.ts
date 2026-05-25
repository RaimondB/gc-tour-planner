// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hand-maintained Kysely table typings. They mirror the schema in
// packages/db/migrations/. Keep migrations and these typings in lockstep;
// kysely-codegen will replace this file once the schema stabilizes.
//
// PostGIS types: a GEOGRAPHY(Point|LineString|Polygon) column is read back
// as the EWKB hex string by node-pg. Repositories convert with ST_AsGeoJSON
// in their SELECT lists, so this typing keeps the raw column as `string`
// — the typed shape (GeoJsonPoint, etc.) belongs in the repository layer.

import type { ColumnType, Generated, JSONColumnType } from "kysely";

/** PostGIS column shape — read as EWKB hex, written via spatial functions. */
type Geography = string;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string | null;
  created_at: Generated<Date>;
}

export interface CachesTable {
  id: Generated<number>;
  owner_id: string | null;
  source: string;
  source_id: string;
  code: string;
  type: string;
  name: string;
  location: Geography;
  difficulty: ColumnType<
    string | null,
    string | number | null,
    string | number | null
  >;
  terrain: ColumnType<
    string | null,
    string | number | null,
    string | number | null
  >;
  size: string | null;
  archived: ColumnType<boolean, boolean | undefined, boolean>;
  last_seen_at: Generated<Date>;
  raw: JSONColumnType<Record<string, unknown>>;
}

export interface CacheAttributesTable {
  cache_id: number;
  attr_id: number;
  positive: boolean;
}

export interface AdditionalWaypointsTable {
  id: Generated<number>;
  cache_id: number;
  type: string;
  location: Geography;
  note: string | null;
}

export interface GpxUploadsTable {
  id: Generated<string>;
  owner_id: string;
  filename: string;
  parsed_count: ColumnType<number, number | undefined, number>;
  status: string;
  error: string | null;
  uploaded_at: Generated<Date>;
}

export interface CacheFindsTable {
  cache_id: number;
  user_id: string;
  found_at: Generated<Date>;
  /** 'manual' | 'gpx-finds-import' | future: 'gc-com' */
  source: string;
}

export interface OsmLanduseTable {
  id: Generated<number>;
  /** 0.1°-cell coordinate, e.g. "5.1,52.0" */
  area_hash: string;
  /**
   * OSM source identifier. 'way:<id>' for a standalone closed way,
   * 'rel:<id>:<ringIndex>' for one outer ring of a multipolygon relation.
   * (area_hash, osm_source) is the dedup key.
   */
  osm_source: string;
  /** Canonical kind from packages/shared/src/landuse. */
  kind: string;
  polygon: Geography;
  fetched_at: Generated<Date>;
}

export interface RouteLegsTable {
  from_cache_id: number;
  to_cache_id: number;
  /** 'foot' (MVP). Other profiles deferred. */
  profile: string;
  meters: ColumnType<string, string | number, string | number>;
  seconds: ColumnType<string, string | number, string | number>;
  /**
   * `'table'` = cell came from OSRM /table (sparse matrix; no geometry).
   * `'route'` = cell came from OSRM /route (full LineString in `geom`).
   * Pass 2 upgrades a 'table' row to 'route' in place when it asks for getLeg.
   */
  source: string;
  /** NULL when `source = 'table'`. Required (DB CHECK) when `source = 'route'`. */
  geom: Geography | null;
  /**
   * Short hash of the OSRM extract that produced this row (see
   * infra/osrm/bootstrap.sh). Rows from a previous extract are ignored on
   * read — forces a re-fetch into the live extract's namespace.
   */
  osrm_version: ColumnType<string, string, string>;
  fetched_at: Generated<Date>;
}

export interface CacheLanduseTable {
  cache_id: number;
  landuse_id: number;
  /** Mirror of osm_landuse.kind; denormalised for fast scoring queries. */
  kind: string;
  computed_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  caches: CachesTable;
  cache_attributes: CacheAttributesTable;
  additional_waypoints: AdditionalWaypointsTable;
  gpx_uploads: GpxUploadsTable;
  cache_finds: CacheFindsTable;
  osm_landuse: OsmLanduseTable;
  route_legs: RouteLegsTable;
  cache_landuse: CacheLanduseTable;
}
