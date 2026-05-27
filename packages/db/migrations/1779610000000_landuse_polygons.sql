-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- ADR-0009: replace Overpass-fed osm_landuse with osm2pgsql-fed
-- landuse_polygons + single-row landuse_import_meta.
--
-- Schema choices:
--   * landuse_polygons primary key is (osm_type, osm_id) — natural identity
--     from OSM, no synthetic id. osm2pgsql's flex-output table writes these
--     two columns directly from `ids = { type = 'any', id_column = 'osm_id',
--     type_column = 'osm_type' }`. The table is also created here so
--     integration tests (which never run osm2pgsql) still have something
--     to seed against; osm2pgsql --create drops and recreates from the
--     Lua definition on first import.
--   * cache_landuse loses landuse_id and uses PK (cache_id, kind). The
--     planner only consumes "what kinds does this cache sit in", never
--     "which specific polygon". Many forests overlapping a cache should
--     count once toward forest-fit.
--   * populate_cache_landuse_in_bbox is rewritten to join against
--     landuse_polygons.geom (the new column name). PLPGSQL defers symbol
--     resolution so this CREATE FUNCTION succeeds even before osm2pgsql
--     has populated the table.

-- Up Migration

-- Drop the Overpass-era artefacts. cache_landuse and the function both
-- reference osm_landuse so they go first.
DROP FUNCTION IF EXISTS populate_cache_landuse_in_bbox(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
);
DROP TABLE IF EXISTS cache_landuse;
DROP TABLE IF EXISTS osm_landuse;

-- Drop landuse precompute state — landuse is now region-scoped, not
-- per-cache. The admin endpoints that read this table get simpler
-- (see apps/api/src/admin/precompute/admin-precompute.service.ts).
-- The 'walking' precompute rows are untouched.
DELETE FROM cache_precompute_state WHERE kind = 'landuse';

-- The osm2pgsql-fed table. Schema must match infra/osm2pgsql/landuse.lua.
CREATE TABLE landuse_polygons (
  osm_id    BIGINT NOT NULL,
  osm_type  CHAR(1) NOT NULL,                       -- 'w' (way) or 'r' (relation)
  kind      TEXT NOT NULL,                          -- one of the 10 canonical kinds
  geom      GEOMETRY(MultiPolygon, 4326) NOT NULL,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX landuse_polygons_geom_gix ON landuse_polygons USING GIST (geom);
CREATE INDEX landuse_polygons_kind_idx ON landuse_polygons (kind);

-- Single-row metadata table. CHECK enforces single-row semantics so the
-- import / replication jobs can blindly UPSERT into id=1.
CREATE TABLE landuse_import_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at   TIMESTAMPTZ NOT NULL,
  pbf_timestamp TIMESTAMPTZ,
  source_file   TEXT,
  -- Replication state. NULL until first osm2pgsql-replication update.
  replicated_at TIMESTAMPTZ,
  replication_state TEXT                            -- e.g. 'ok', 'error: <msg>'
);

-- New cache_landuse: PK (cache_id, kind). A cache in three forest polygons
-- gets ONE row of kind='forest', not three. That matches how cluster
-- scoring uses the data (presence-of-kind, not polygon-count).
CREATE TABLE cache_landuse (
  cache_id    BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_id, kind)
);
CREATE INDEX cache_landuse_cache_idx ON cache_landuse (cache_id);
CREATE INDEX cache_landuse_kind_idx  ON cache_landuse (kind);

-- Lazy populate: walk every (cache, kind) pair where the cache lies inside
-- some landuse_polygons.geom of that kind AND the polygon overlaps the
-- requested bbox. ON CONFLICT DO NOTHING keeps the function idempotent —
-- replanning a region does not double-write. Returns the number of new
-- rows actually inserted.
--
-- The join uses geometry rather than geography because landuse_polygons.geom
-- is stored as GEOMETRY (matches osm2pgsql's flex-output type for projection
-- 4326). Cache locations are stored as GEOGRAPHY; casting one side to the
-- other on every row would defeat the GIST index, so we cast the bbox to
-- both types and use the right one per join arm.
CREATE OR REPLACE FUNCTION populate_cache_landuse_in_bbox(
  min_lng DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lng DOUBLE PRECISION,
  max_lat DOUBLE PRECISION
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  inserted BIGINT;
  bbox_geom GEOMETRY;
  bbox_geog GEOGRAPHY;
BEGIN
  bbox_geom := ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326);
  bbox_geog := bbox_geom::geography;
  WITH ins AS (
    INSERT INTO cache_landuse (cache_id, kind)
    SELECT DISTINCT c.id, l.kind
    FROM caches c
    JOIN landuse_polygons l
      ON l.geom && bbox_geom
     AND ST_Contains(l.geom, c.location::geometry)
    WHERE ST_Intersects(c.location, bbox_geog)
    ON CONFLICT (cache_id, kind) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM ins;
  RETURN inserted;
END;
$$;


-- Down Migration

DROP FUNCTION IF EXISTS populate_cache_landuse_in_bbox(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
);
DROP TABLE IF EXISTS cache_landuse;
DROP TABLE IF EXISTS landuse_import_meta;
DROP TABLE IF EXISTS landuse_polygons;

-- Recreate the prior schema so a rollback leaves the DB in a sensible
-- shape for the old Overpass code path (which the rollback would also
-- restore). Functionally equivalent to 1748246400000_osm_landuse.sql
-- + 1748332800000_osm_landuse_source.sql + 1779609700000_cache_landuse.sql.
CREATE TABLE osm_landuse (
  id          BIGSERIAL PRIMARY KEY,
  area_hash   TEXT NOT NULL,
  osm_source  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  polygon     GEOGRAPHY(Polygon, 4326) NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (area_hash, osm_source)
);
CREATE INDEX osm_landuse_polygon_gist ON osm_landuse USING GIST (polygon);
CREATE INDEX osm_landuse_area_idx ON osm_landuse (area_hash);
CREATE INDEX osm_landuse_kind_idx ON osm_landuse (kind);

CREATE TABLE cache_landuse (
  cache_id    BIGINT NOT NULL REFERENCES caches(id)      ON DELETE CASCADE,
  landuse_id  BIGINT NOT NULL REFERENCES osm_landuse(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_id, landuse_id)
);
CREATE INDEX cache_landuse_cache_idx ON cache_landuse (cache_id);
CREATE INDEX cache_landuse_kind_idx  ON cache_landuse (kind);

CREATE OR REPLACE FUNCTION populate_cache_landuse_in_bbox(
  min_lng DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lng DOUBLE PRECISION,
  max_lat DOUBLE PRECISION
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  inserted BIGINT;
  bbox     GEOGRAPHY;
BEGIN
  bbox := ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography;
  WITH ins AS (
    INSERT INTO cache_landuse (cache_id, landuse_id, kind)
    SELECT c.id, l.id, l.kind
    FROM caches c
    JOIN osm_landuse l
      ON ST_Intersects(l.polygon, bbox)
     AND ST_Contains(l.polygon::geometry, c.location::geometry)
    WHERE ST_Intersects(c.location, bbox)
    ON CONFLICT (cache_id, landuse_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM ins;
  RETURN inserted;
END;
$$;
