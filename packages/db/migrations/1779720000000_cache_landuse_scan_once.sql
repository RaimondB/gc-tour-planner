-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Make cache_landuse population scan each cache ONCE instead of re-running the
-- full point-in-polygon spatial join (caches × 2.1M landuse_polygons) on every
-- discovery. Profiling (discovery-timing bench) showed populate_cache_landuse_
-- in_bbox cost ~50-65 ms per Pass-1 discovery while inserting ZERO rows — the
-- region was already populated, but the function re-derived membership from
-- scratch every call because ON CONFLICT DO NOTHING still pays the join.
--
-- Fix: stamp `caches.landuse_scanned_at` when a cache is scanned and only scan
-- unscanned caches. A partial index on the NULL stamp makes the steady-state
-- ("everything already scanned") case a near-instant no-op.
--
-- Completeness: stamping per-bbox is safe. Any landuse polygon that contains a
-- cache's point necessarily intersects EVERY bbox that contains that point (the
-- shared point witnesses the intersection), so the first bbox to scan a cache
-- captures its full membership — no later or larger bbox can add a kind. The
-- `landuse_scanned_at IS NULL` gate therefore never drops a real membership.
--
-- Invalidation: when a cache moves (solved-coord revert, GPX relocation) its
-- cache_landuse rows are deleted and `landuse_scanned_at` is reset to NULL in
-- the same transaction (see caches.repository.clearSolved + gpx.repository), so
-- the next populate re-scans it. A wholesale landuse_polygons re-import is a
-- manual osm2pgsql one-shot; reset all stamps afterwards to force a re-scan:
--   TRUNCATE cache_landuse; UPDATE caches SET landuse_scanned_at = NULL;

-- Up Migration

ALTER TABLE caches ADD COLUMN landuse_scanned_at TIMESTAMPTZ;

-- Drives the steady-state no-op: the populate function's scope query filters on
-- `landuse_scanned_at IS NULL`, so this partial index finds the (usually zero)
-- unscanned caches without touching the scanned majority.
CREATE INDEX caches_landuse_unscanned_idx
  ON caches (id) WHERE landuse_scanned_at IS NULL;

-- Backfill: every cache that already has a cache_landuse row was fully scanned
-- by the old bbox populate (membership is complete per the completeness note),
-- so stamp it now and skip a needless first re-scan. Caches with zero recorded
-- membership stay NULL and get scanned once on their region's next populate —
-- self-healing, no membership lost.
UPDATE caches
SET landuse_scanned_at = now()
WHERE id IN (SELECT DISTINCT cache_id FROM cache_landuse);

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
  WITH scope AS (
    -- Only the caches in this bbox that have never been landuse-scanned. When
    -- the region is already scanned this is empty and the join below is skipped
    -- (the partial index resolves it without scanning landuse_polygons).
    SELECT c.id, c.location
    FROM caches c
    WHERE c.landuse_scanned_at IS NULL
      AND ST_Intersects(c.location, bbox_geog)
  ),
  ins AS (
    INSERT INTO cache_landuse (cache_id, kind)
    SELECT DISTINCT s.id, l.kind
    FROM scope s
    JOIN landuse_polygons l
      ON l.geom && bbox_geom
     AND ST_Contains(l.geom, s.location::geometry)
    ON CONFLICT (cache_id, kind) DO NOTHING
    RETURNING 1
  ),
  -- Stamp every in-scope cache as scanned, including caches that fell inside no
  -- polygon (zero inserts) — that's exactly the case the old function could not
  -- distinguish and kept re-scanning forever. Data-modifying CTEs always run,
  -- even though the final SELECT only reads `ins`.
  upd AS (
    UPDATE caches
    SET landuse_scanned_at = now()
    WHERE id IN (SELECT id FROM scope)
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM ins;
  RETURN inserted;
END;
$$;

-- Down Migration

-- Restore the prior always-rescan function body.
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

DROP INDEX IF EXISTS caches_landuse_unscanned_idx;
ALTER TABLE caches DROP COLUMN IF EXISTS landuse_scanned_at;
