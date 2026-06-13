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
  is_admin: Generated<boolean>;
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
  /**
   * Effective coordinate the planner uses (migration 1779710000000): the
   * user-supplied solved coordinate when `solved`, otherwise the posted
   * coordinate. Every spatial query reads this column, so the solved-coords
   * feature lands entirely on the upload path.
   */
  location: Geography;
  /**
   * Raw coordinate from the most recent Pocket Query (original posted coord).
   * A normal PQ refreshes this but only writes `location` when `solved` is
   * false — so a routine re-upload never clobbers a solved coordinate. NULL
   * only for caches first seen via a solvedCoordinates upload. Used to revert
   * `location` when solved coords are removed. See migration 1779710000000.
   */
  published_location: ColumnType<
    Geography | null,
    Geography | null | undefined,
    Geography | null
  >;
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
  /**
   * Cache owner temporarily disabled the cache (Groundspeak `available="False"
   * archived="False"`). Distinct from `archived` — the map renders disabled
   * caches with a "Z" overlay rather than hiding them. DB default FALSE so
   * insert is optional. See migration 1779660000000.
   */
  disabled: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * The <gpx><time> of the upload that last wrote this row. NULL for pre-PR2
   * rows (provenance unknown). Used by the upsert staleness guard so a stale
   * PQ replayed against a fresher dataset can't downgrade newer rows.
   */
  source_exported_at: ColumnType<
    Date | null,
    Date | null | undefined,
    Date | null
  >;
  /**
   * FR-F8 tool-hint keys (e.g. 'fishingRod', 'binoculars', 'magnet') parsed
   * from the cache description by `scanDescriptionHints`. Three-state
   * nullability:
   *   NULL                = never scanned (pre-PR3 row, or scan skipped).
   *                         Operator can back-fill via
   *                         `POST /admin/uploads/:id/reprocess` (FR-I9).
   *   `[]`                = scanned but no hints matched.
   *   `['fishingRod', …]` = scanned and matched at least one entry.
   * Read on every `listCaches` (small projection cost) but never used in a
   * WHERE clause — filtering is client-side. No index. See migration
   * 1779670000000.
   */
  description_hints: ColumnType<
    string[] | null,
    string[] | null | undefined,
    string[] | null
  >;
  /**
   * True when `location` holds a user-supplied solved/corrected coordinate
   * (Mystery puzzle solution or Multi final), set via a solvedCoordinates GPX
   * upload. DB default FALSE so insert is optional. Drives the "only solved
   * mysteries" filter. See migration 1779710000000.
   */
  solved: ColumnType<boolean, boolean | undefined, boolean>;
  /** When `solved` was first set TRUE. NULL while solved=FALSE. */
  solved_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * When this cache was last scanned for landuse-polygon membership. NULL =
   * never scanned → `populate_cache_landuse_in_bbox` will (re)scan it; stamped
   * once scanned so steady-state discovery skips the spatial join. Reset to
   * NULL whenever the cache's `location` moves (its cache_landuse rows are
   * deleted in the same transaction). See migration 1779720000000.
   */
  landuse_scanned_at: ColumnType<
    Date | null,
    Date | null | undefined,
    Date | null
  >;
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
  /** 'received' | 'parsed' | 'failed' — enforced in GpxService, not DB. */
  status: string;
  error: string | null;
  uploaded_at: Generated<Date>;
  /**
   * Size in bytes of the gzipped XML stored at /srv/uploads/{id}.gpx.gz.
   * NULL when no raw file is on disk (pre-feature rows or storage disabled).
   */
  raw_size_bytes: ColumnType<bigint | null, bigint | undefined, bigint | null>;
  /**
   * Lowercase-hex SHA-256 of the uncompressed XML bytes (64 chars). Used for
   * integrity check on reprocess + future dedupe. NULL when no raw file.
   */
  raw_sha256: ColumnType<string | null, string | undefined, string | null>;
  /**
   * The <gpx><time> of the PQ (when Groundspeak generated it). NULL when the
   * GPX had no <gpx><time> element. Copied onto each upserted cache's
   * `source_exported_at` at parse time. See migration 1779660000000.
   */
  exported_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface CacheFindsTable {
  cache_id: number;
  user_id: string;
  found_at: Generated<Date>;
  /** 'manual' | 'gpx-finds-import' | future: 'gc-com' */
  source: string;
}

/**
 * Landuse polygons imported from a Geofabrik PBF via osm2pgsql (ADR-0009).
 * Schema is also declared in `infra/osm2pgsql/landuse.lua` — keep the two in
 * lockstep (osm2pgsql `--create` will drop and recreate this table on first
 * import, using the Lua definition as the source of truth).
 */
export interface LandusePolygonsTable {
  /** OSM id of the way or relation. */
  osm_id: number;
  /** 'w' (way) or 'r' (relation). */
  osm_type: string;
  /** Canonical kind from packages/shared/src/landuse. */
  kind: string;
  /**
   * MultiPolygon (geometry, SRID 4326). osm2pgsql normalises closed ways
   * and multipolygon relations into MultiPolygon. Repositories use
   * ST_AsGeoJSON to read.
   */
  geom: string;
}

/**
 * `amenity=parking` features ingested by the same osm2pgsql pass that
 * populates landuse_polygons (ADR-0011). One row per OSM node, closed
 * way, or multipolygon relation tagged `amenity=parking`.
 *
 * Schema declared in `infra/osm2pgsql/osm-features.lua` and
 * `packages/db/migrations/1779620000000_parking_facilities.sql` — keep
 * them in lockstep. Freshness shares `landuse_import_meta` (no separate
 * metadata row).
 */
export interface ParkingFacilitiesTable {
  osm_id: number;
  /** 'n' (node), 'w' (way), or 'r' (relation). */
  osm_type: string;
  /**
   * Untyped geometry — Point for nodes, MultiPolygon for ways/relations.
   * Repositories use ST_AsGeoJSON + ST_GeometryType to dispatch.
   */
  geom: string;
  /** Raw OSM `access` value: yes | customers | permit | private | no | … */
  access: string | null;
  /** Effective fee after `parking:condition` normalisation: yes | no | donation | NULL. */
  fee: string | null;
  /** OSM `parking` tag: surface | multi-storey | underground | … */
  parking_type: string | null;
  /** Best-effort integer parse of `capacity`. NULL when unparseable. */
  capacity: number | null;
  maxstay: string | null;
  supervised: string | null;
  opening_hours: string | null;
  surface: string | null;
  name: string | null;
}

/**
 * Quiet, car-accessible road ways (ADR-0012). Used to snap "nearest road"
 * tour-start parking candidates onto roads you can actually park-and-walk
 * from, then score them with the loop-aware selector.
 *
 * Schema declared in `infra/osm2pgsql/osm-features.lua` and
 * `packages/db/migrations/1779680000000_car_roads.sql` — keep them in
 * lockstep. Freshness shares `landuse_import_meta` (no separate metadata
 * row). Roads are ways only, so there is no `osm_type` column.
 *
 * The Lua applies the coarse class filter (highway IN the 5 eligible
 * classes); the fine filter (access / motor_vehicle / maxspeed_kmh /
 * service=driveway) runs at query time in `car-roads.repository.ts`.
 */
export interface CarRoadsTable {
  osm_id: number;
  /** LineString in 4326 (open ways). Repositories use ST_ClosestPoint. */
  geom: string;
  /** residential | living_street | unclassified | service | tertiary. */
  highway: string;
  /** Raw OSM `access`: yes | private | no | destination | … | NULL. */
  access: string | null;
  /** Raw OSM `motor_vehicle`: yes | no | private | … | NULL. */
  motor_vehicle: string | null;
  /** Pre-parsed km/h. NULL when absent/unparseable (kept by the filter). */
  maxspeed_kmh: number | null;
  /** `service` value (driveway | parking_aisle | …) for highway=service. */
  service: string | null;
  name: string | null;
}

/**
 * Single-row metadata table tracking the most recent landuse import +
 * replication run. `id` is constrained to 1 by a CHECK so jobs can
 * blindly UPSERT.
 */
export interface LanduseImportMetaTable {
  id: number;
  imported_at: Date;
  pbf_timestamp: Date | null;
  source_file: string | null;
  /** NULL until the first successful osm2pgsql-replication update. */
  replicated_at: Date | null;
  /** 'ok' or 'error: …'. NULL before any replication run. */
  replication_state: string | null;
}

export interface RouteLegsTable {
  from_cache_id: number;
  to_cache_id: number;
  /** 'foot' (MVP). Other profiles deferred. */
  profile: string;
  /** NULL when `source = 'noroute'` (DB CHECK). Required for 'table' + 'route'. */
  meters: ColumnType<
    string | null,
    string | number | null,
    string | number | null
  >;
  seconds: ColumnType<
    string | null,
    string | number | null,
    string | number | null
  >;
  /**
   * `'table'`   = cell came from OSRM /table (sparse matrix; no geometry).
   * `'route'`   = cell came from OSRM /route (full LineString in `geom`).
   * `'noroute'` = OSRM was asked but returned no route between the two
   *               points. Acts as a negative cache so cluster discovery
   *               doesn't re-ask OSRM for the same unreachable pair on
   *               every run. meters/seconds/geom are all NULL on these
   *               rows (DB CHECK).
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

/**
 * Membership materialisation: (cache_id, kind) rows for every kind the
 * cache sits inside. PK is (cache_id, kind), so a cache inside three
 * different forest polygons gets ONE row of kind='forest'. Populated
 * lazily on plan via `populate_cache_landuse_in_bbox(...)`.
 */
export interface CacheLanduseTable {
  cache_id: number;
  /** Canonical kind from packages/shared/src/landuse. */
  kind: string;
  computed_at: Generated<Date>;
}

/** Postgres enum `precompute_kind`. */
export type PrecomputeKind = "walking" | "landuse";

/** Postgres enum `precompute_state`. */
export type PrecomputeState = "pending" | "in_progress" | "fresh" | "failed";

/**
 * Tracks freshness of precompute jobs per (cache, kind). Written by the
 * walking-precompute and overpass-refresh processors, read by the admin
 * `/admin/precompute/*` endpoints. See docs/design/precompute.md.
 */
export interface CachePrecomputeStateTable {
  cache_id: number;
  kind: PrecomputeKind;
  state: PrecomputeState;
  /** NULL for kind='landuse' and for rows that have never reached 'fresh'. */
  osrm_version: string | null;
  /** NULL until the first successful run. */
  fetched_at: ColumnType<Date | null, Date | null, Date | null>;
  error_text: string | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * Cartesian product of (caches × {walking, landuse}) LEFT JOIN
 * cache_precompute_state. `missing=true` marks (cache, kind) pairs that
 * have no row yet. Used by the admin summary + retrigger-stale endpoints.
 */
export interface CachePrecomputeStateView {
  cache_id: number;
  kind: PrecomputeKind;
  state: PrecomputeState | null;
  osrm_version: string | null;
  fetched_at: Date | null;
  error_text: string | null;
  updated_at: Date | null;
  missing: boolean;
}

/**
 * Saved landuse-weighted scoring profiles (M5-β). The planner reads the
 * `kinds` array and credits any cache sitting inside a `landuse_polygons`
 * row of one of those kinds. `owner_id IS NULL` rows are system profiles
 * visible to every user; non-null are per-user.
 *
 * Schema declared in
 * `packages/db/migrations/1779630000000_landuse_profiles.sql`.
 */
export interface LanduseProfilesTable {
  id: string;
  owner_id: string | null;
  name: string;
  description: string | null;
  /** JSON array of canonical kind strings (validated app-side). */
  kinds: string[];
  created_at: Date;
}

export interface Database {
  users: UsersTable;
  caches: CachesTable;
  cache_attributes: CacheAttributesTable;
  additional_waypoints: AdditionalWaypointsTable;
  gpx_uploads: GpxUploadsTable;
  cache_finds: CacheFindsTable;
  landuse_polygons: LandusePolygonsTable;
  parking_facilities: ParkingFacilitiesTable;
  car_roads: CarRoadsTable;
  landuse_import_meta: LanduseImportMetaTable;
  landuse_profiles: LanduseProfilesTable;
  route_legs: RouteLegsTable;
  cache_landuse: CacheLanduseTable;
  cache_precompute_state: CachePrecomputeStateTable;
  v_cache_precompute_state: CachePrecomputeStateView;
}
