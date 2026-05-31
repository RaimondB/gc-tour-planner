-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- ADR-0012: introduce car_roads, populated from quiet car-accessible OSM
-- highways by the same osm2pgsql import that produces landuse_polygons +
-- parking_facilities. The Lua (infra/osm2pgsql/osm-features.lua) defines and
-- creates the table on --create; this migration pre-creates it so integration
-- tests that don't run osm2pgsql still have something to seed against.
--
-- Schema choices:
--   * Primary key is osm_id alone — roads are ways only (the Lua table uses
--     ids = { type='way' }), so there is no osm_type column unlike the other
--     two OSM tables.
--   * geom is GEOMETRY(LineString, 4326) — roads are open ways.
--   * Coarse class filter (highway IN {residential, living_street,
--     unclassified, service, tertiary}) is applied in the Lua so the table
--     stays small. The stored columns (access, motor_vehicle, maxspeed_kmh,
--     service) drive the FINE filter at query time in
--     apps/api/src/osm/car-roads.repository.ts, which can be retuned without
--     a re-import.
--   * maxspeed_kmh is pre-parsed to an integer by the Lua so the query is a
--     plain comparison; NULL means unknown/unparseable (kept by the filter).
--   * No metadata table of its own — freshness is shared with
--     landuse_import_meta (all three tables are populated atomically by the
--     same osm2pgsql invocation, see infra/osm2pgsql/bootstrap.sh).

-- Up Migration

CREATE TABLE car_roads (
  osm_id        BIGINT NOT NULL,
  geom          GEOMETRY(LineString, 4326) NOT NULL,
  highway       TEXT NOT NULL,                          -- residential | living_street | unclassified | service | tertiary
  access        TEXT,                                   -- yes | private | no | destination | … | NULL
  motor_vehicle TEXT,                                   -- yes | no | private | … | NULL
  maxspeed_kmh  INTEGER,                                -- pre-parsed km/h; NULL when absent/unparseable
  service       TEXT,                                   -- driveway | parking_aisle | alley | … (only for highway=service)
  name          TEXT,
  PRIMARY KEY (osm_id)
);

-- GIST on geom is non-negotiable — every read path filters by bbox + nearest.
CREATE INDEX car_roads_geom_gix ON car_roads USING GIST (geom);

-- btree on highway for the planner's class filter (5 cardinal values).
CREATE INDEX car_roads_highway_idx ON car_roads (highway);


-- Down Migration

DROP TABLE IF EXISTS car_roads;
