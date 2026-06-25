-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- ADR-0036: named settlement nodes (place=city/town/village/hamlet/suburb), the
-- source of a tour's "place" label ("Wageningen"). Populated from OSM by the
-- same osm2pgsql pass that builds landuse_polygons / parking_facilities
-- (infra/osm2pgsql/osm-features.lua). osm2pgsql flex --create DROPs + recreates
-- this table from the Lua on import; this migration pre-creates a matching shape
-- so integration tests can seed it without running osm2pgsql, and the Kysely
-- types line up either way.
--
-- Points only — OSM maps a settlement as a single node at its centre, so the
-- nearest place node to a tour's start anchors its name (point distance, not a
-- polygon containment). Storage is small: ~tens of thousands of point rows for
-- the imported regions.

-- Up Migration

CREATE TABLE place_points (
  osm_id     BIGINT NOT NULL,
  place      TEXT NOT NULL,                  -- city | town | village | hamlet | suburb
  name       TEXT NOT NULL,
  population INTEGER,                        -- best-effort parse; NULL when untagged
  geom       GEOMETRY(Point, 4326) NOT NULL,
  PRIMARY KEY (osm_id)
);

-- GIST on geom backs the nearest-place lookup (KNN `geom <-> point` + the exact
-- ST_Distance ordering) — every read path is a nearest-by-point query.
CREATE INDEX place_points_geom_gix ON place_points USING GIST (geom);

-- btree on place backs the kind-priority preference (city > town > village > …).
CREATE INDEX place_points_place_idx ON place_points (place);

-- Down Migration

DROP TABLE IF EXISTS place_points;
