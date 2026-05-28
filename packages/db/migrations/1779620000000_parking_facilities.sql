-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- ADR-0011: introduce parking_facilities, populated from OSM amenity=parking
-- by the same osm2pgsql import that produces landuse_polygons. The Lua
-- (infra/osm2pgsql/osm-features.lua) defines and creates the table on
-- --create; this migration pre-creates it so integration tests that don't
-- run osm2pgsql still have something to seed against.
--
-- Schema choices:
--   * Primary key (osm_type, osm_id) — same natural-identity pattern as
--     landuse_polygons. osm_type extended to 'n' (node) in addition to
--     'w' / 'r' because many parking spots in OSM are nodes.
--   * geom is GEOMETRY (untyped), not Geometry(MultiPolygon|Point). A node
--     parking yields a Point; a way/relation yields a (Multi)Polygon.
--     Clients branch on osm_type.
--   * No metadata table of its own — freshness is shared with
--     landuse_import_meta (both tables are populated atomically by the
--     same osm2pgsql invocation, see infra/osm2pgsql/bootstrap.sh).

-- Up Migration

CREATE TABLE parking_facilities (
  osm_id        BIGINT NOT NULL,
  -- osm2pgsql flex writes uppercase: 'N' (node) | 'W' (way) | 'R' (relation).
  osm_type      CHAR(1) NOT NULL,
  geom          GEOMETRY NOT NULL,                    -- Point for nodes, MultiPolygon for ways/relations, 4326
  access        TEXT,                                 -- yes | customers | permit | private | no | destination | …
  fee           TEXT,                                 -- yes | no | donation | NULL (unknown)
  parking_type  TEXT,                                 -- surface | multi-storey | underground | …
  capacity      INTEGER,                              -- best-effort parse; NULL when unparseable
  maxstay       TEXT,                                 -- free-form ("2h", "30 min", …); display only
  supervised    TEXT,                                 -- yes | no | NULL
  opening_hours TEXT,
  surface       TEXT,
  name          TEXT,
  PRIMARY KEY (osm_type, osm_id)
);

-- GIST on geom is non-negotiable — every read path filters by bbox.
CREATE INDEX parking_facilities_geom_gix ON parking_facilities USING GIST (geom);

-- btree on access + fee for the planner's "find candidates" filter. Both
-- have only ~5 cardinal values; btree is fine (PG can use it as a hash).
CREATE INDEX parking_facilities_access_idx ON parking_facilities (access);
CREATE INDEX parking_facilities_fee_idx ON parking_facilities (fee);


-- Down Migration

DROP TABLE IF EXISTS parking_facilities;
