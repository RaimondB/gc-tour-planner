-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Replace osm_way_id with osm_source so we can also store relation-derived
-- polygons. Format: 'way:<wayId>' or 'rel:<relId>:<ringIndex>'. Existing rows
-- (all ways) are migrated in place; the unique constraint moves with them.
-- A few residential / forest blocks in real maps are multipolygon relations
-- whose outer ring is split across several ways — those were silently dropped
-- by the old parser and reappear once this migration + the new parser ship.

-- Up Migration

ALTER TABLE osm_landuse
  ADD COLUMN osm_source TEXT;

UPDATE osm_landuse
  SET osm_source = 'way:' || osm_way_id::text;

ALTER TABLE osm_landuse
  ALTER COLUMN osm_source SET NOT NULL;

ALTER TABLE osm_landuse
  DROP CONSTRAINT osm_landuse_area_hash_osm_way_id_key;

ALTER TABLE osm_landuse
  DROP COLUMN osm_way_id;

ALTER TABLE osm_landuse
  ADD CONSTRAINT osm_landuse_area_source_key UNIQUE (area_hash, osm_source);


-- Down Migration

ALTER TABLE osm_landuse
  ADD COLUMN osm_way_id BIGINT;

UPDATE osm_landuse
  SET osm_way_id = (regexp_replace(osm_source, '^(way|rel):([0-9]+).*$', '\2'))::bigint
  WHERE osm_source ~ '^(way|rel):[0-9]+';

DELETE FROM osm_landuse WHERE osm_way_id IS NULL;

ALTER TABLE osm_landuse
  ALTER COLUMN osm_way_id SET NOT NULL;

ALTER TABLE osm_landuse
  DROP CONSTRAINT osm_landuse_area_source_key;

ALTER TABLE osm_landuse
  DROP COLUMN osm_source;

ALTER TABLE osm_landuse
  ADD CONSTRAINT osm_landuse_area_hash_osm_way_id_key UNIQUE (area_hash, osm_way_id);
