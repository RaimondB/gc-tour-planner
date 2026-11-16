-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- ADR-0036: add a `name` column to landuse_polygons so a tour sitting inside a
-- named park / forest / nature reserve can be labelled by it ("Bospark",
-- "de Veluwe"). Populated by the osm2pgsql pass
-- (infra/osm2pgsql/osm-features.lua, which now emits `name = tags.name`).
--
-- osm2pgsql flex runs in --create mode and DROPs + recreates its tables from the
-- Lua on every import, so production gets the column from the import. This
-- migration pre-adds it for integration-test DBs that never run osm2pgsql (and
-- so the Kysely types match either way). No index — `name` is read only after a
-- geometry/containment filter has already narrowed to one row.

-- Up Migration

ALTER TABLE landuse_polygons ADD COLUMN name TEXT;

-- Down Migration

ALTER TABLE landuse_polygons DROP COLUMN IF EXISTS name;
