-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Solved mystery coordinates: let a user upload a Groundspeak GPX that carries
-- the *corrected* coordinates for caches they've solved (Mystery puzzles) or
-- the final location of a Multi. Groundspeak substitutes corrected coords into
-- the primary <wpt> with no machine-readable marker, so the user asserts it via
-- a `solvedCoordinates` upload flag.
--
-- Column semantics (the key design decision)
-- -------------------------------------------
-- caches.location  KEEPS its name but its MEANING widens to "the effective
--   coordinate the planner uses": the user-supplied solved coordinate when
--   `solved`, otherwise the posted coordinate. Every spatial query
--   (radius/ST_DWithin, clustering, walking-graph/KNN, landuse, map) already
--   reads `location`, so nothing downstream changes — the whole feature lands
--   on the upload path.
--
-- caches.published_location
--   The raw coordinate from the most recent Pocket Query (the original posted
--   coord). A normal PQ always refreshes this, but only writes `location` when
--   the cache is NOT solved — so a routine PQ re-upload can never clobber a
--   solved coordinate. Kept so "remove solved coordinates" can revert
--   `location = COALESCE(published_location, location)`. NULL only for caches
--   first seen via a solvedCoordinates upload (no posted coord known yet; a
--   later normal PQ fills it).
--
-- caches.solved / caches.solved_at
--   TRUE when `location` holds a user-supplied solved coordinate. `solved_at`
--   records when it was first set. Drives the "only solved mysteries" filter.
--
-- Back-fill
-- ---------
-- Today (no row is solved yet) `location` IS the posted coord for every row, so
-- seed `published_location = location` to keep the revert path well-defined.
--
-- Index added
-- -----------
--   CREATE INDEX caches_owner_solved_idx ON caches (owner_id) WHERE solved;
-- Supports the "only solved mysteries" filter (a small partial index — solved
-- caches are rare). No new GiST index: spatial reads still hit `location` and
-- its existing `caches_location_gist`.

-- Up Migration

ALTER TABLE caches
  ADD COLUMN published_location GEOGRAPHY(Point, 4326),
  ADD COLUMN solved             BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN solved_at          TIMESTAMPTZ;

UPDATE caches SET published_location = location;

COMMENT ON COLUMN caches.location IS
  'Effective coordinate the planner uses: the user-supplied solved coordinate when solved=true, otherwise the posted coordinate. All spatial queries read this column.';
COMMENT ON COLUMN caches.published_location IS
  'Raw coordinate from the most recent Pocket Query (original posted coord). NULL only for caches first seen via a solvedCoordinates upload. Used to revert when solved coords are removed.';
COMMENT ON COLUMN caches.solved IS
  'True when location holds a user-supplied solved/corrected coordinate (Mystery solution or Multi final), set via a solvedCoordinates GPX upload.';
COMMENT ON COLUMN caches.solved_at IS
  'When solved was first set TRUE (the solved upload''s processing time). NULL while solved=FALSE.';

CREATE INDEX IF NOT EXISTS caches_owner_solved_idx
  ON caches (owner_id)
  WHERE solved;


-- Down Migration

DROP INDEX IF EXISTS caches_owner_solved_idx;

ALTER TABLE caches
  DROP COLUMN IF EXISTS solved_at,
  DROP COLUMN IF EXISTS solved,
  DROP COLUMN IF EXISTS published_location;
