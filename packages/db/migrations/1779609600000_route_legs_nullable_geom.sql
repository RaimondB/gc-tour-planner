-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Pass 1 redesign — let `route_legs` cache cheap "matrix-only" cells too,
-- not just full route lines. The cluster-discovery sparse k-NN matrix needs
-- meters/seconds for tens of thousands of edges but not geometry. Pass 2
-- still wants the LineString and upgrades a row in-place from
-- source='table' → source='route' when it asks for getLeg.
--
-- Two-step: add nullable column, backfill existing rows (all came from
-- /route, so source='route'), then enforce the CHECK + the
-- (source='route' ⇒ geom NOT NULL) invariant.

-- Up Migration

ALTER TABLE route_legs ADD COLUMN source TEXT;
UPDATE route_legs SET source = 'route' WHERE source IS NULL;
ALTER TABLE route_legs ALTER COLUMN source SET NOT NULL;
ALTER TABLE route_legs ADD CONSTRAINT route_legs_source_chk
  CHECK (source IN ('table', 'route'));

ALTER TABLE route_legs ALTER COLUMN geom DROP NOT NULL;
ALTER TABLE route_legs ADD CONSTRAINT route_legs_route_has_geom_chk
  CHECK (source <> 'route' OR geom IS NOT NULL);


-- Down Migration

ALTER TABLE route_legs DROP CONSTRAINT IF EXISTS route_legs_route_has_geom_chk;
ALTER TABLE route_legs DROP CONSTRAINT IF EXISTS route_legs_source_chk;
DELETE FROM route_legs WHERE geom IS NULL; -- can't restore NOT NULL otherwise
ALTER TABLE route_legs ALTER COLUMN geom SET NOT NULL;
ALTER TABLE route_legs DROP COLUMN source;
