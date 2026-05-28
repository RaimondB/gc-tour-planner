-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Add a `source='noroute'` sentinel for cache pairs OSRM cannot route
-- between. Today every cluster discovery re-asks OSRM for the same
-- unreachable pairs because we silently skip null cells from /table —
-- the precompute can't store "no route exists", so the negative result
-- never becomes a cache hit. This migration adds the sentinel so the
-- discovery walking-graph builder + precompute can record "tried, no
-- route" and short-circuit on subsequent calls.
--
-- Invariants:
--   * source='table' or 'route' → meters + seconds NOT NULL (unchanged).
--   * source='route'  → geom NOT NULL (unchanged; route_legs_route_has_geom_chk).
--   * source='noroute' → meters + seconds + geom all NULL.
-- The osrm_version column gives the rows a per-extract namespace; a fresh
-- extract will invalidate the noroute rows so a network update can yield
-- a real route next time around.

-- Up Migration

-- Loosen meters/seconds NOT NULL so noroute rows can carry NULLs.
ALTER TABLE route_legs ALTER COLUMN meters DROP NOT NULL;
ALTER TABLE route_legs ALTER COLUMN seconds DROP NOT NULL;

-- Extend the source CHECK to allow the new sentinel.
ALTER TABLE route_legs DROP CONSTRAINT route_legs_source_chk;
ALTER TABLE route_legs ADD CONSTRAINT route_legs_source_chk
  CHECK (source IN ('table', 'route', 'noroute'));

-- Enforce the meters/seconds NULL pattern by source. Keeps the schema
-- self-describing: any future reader can tell from a row's source what
-- the other columns mean without consulting docs.
ALTER TABLE route_legs ADD CONSTRAINT route_legs_noroute_nulls_chk
  CHECK (
    (source IN ('table', 'route')
     AND meters IS NOT NULL
     AND seconds IS NOT NULL)
    OR
    (source = 'noroute'
     AND meters IS NULL
     AND seconds IS NULL
     AND geom IS NULL)
  );


-- Down Migration

ALTER TABLE route_legs DROP CONSTRAINT IF EXISTS route_legs_noroute_nulls_chk;

-- Drop any noroute rows so the old CHECK + NOT NULL columns can be
-- restored cleanly.
DELETE FROM route_legs WHERE source = 'noroute';

ALTER TABLE route_legs DROP CONSTRAINT route_legs_source_chk;
ALTER TABLE route_legs ADD CONSTRAINT route_legs_source_chk
  CHECK (source IN ('table', 'route'));

ALTER TABLE route_legs ALTER COLUMN meters SET NOT NULL;
ALTER TABLE route_legs ALTER COLUMN seconds SET NOT NULL;
