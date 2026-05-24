-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- M3: cached OpenStreetMap landuse polygons.
-- One row per landuse polygon (way). `area_hash` identifies the 0.1°-square
-- cell the polygon was fetched in, so freshness is tracked per cell.
-- Multiple cells can independently expire; a single polygon never appears
-- twice for the same cell (UNIQUE on (area_hash, osm_way_id)).

-- Up Migration

CREATE TABLE osm_landuse (
  id          BIGSERIAL PRIMARY KEY,
  area_hash   TEXT NOT NULL,
  osm_way_id  BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  polygon     GEOGRAPHY(Polygon, 4326) NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (area_hash, osm_way_id)
);
CREATE INDEX osm_landuse_polygon_gist ON osm_landuse USING GIST (polygon);
CREATE INDEX osm_landuse_area_idx ON osm_landuse (area_hash);
CREATE INDEX osm_landuse_kind_idx ON osm_landuse (kind);


-- Down Migration

DROP TABLE IF EXISTS osm_landuse;
