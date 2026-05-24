-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Pass 1 redesign — precomputed (cache, landuse polygon) membership join.
-- Pass 1 cluster scoring wants to ask "what fraction of this cluster sits in
-- forest polygons?" cheaply, so we materialise ST_Contains results into a
-- denormalised join populated lazily on first plan touching a region.
--
-- A cache may sit inside many polygons of different kinds; PRIMARY KEY is
-- (cache_id, landuse_id) — never duplicate the same containment row.

-- Up Migration

CREATE TABLE cache_landuse (
  cache_id   BIGINT NOT NULL REFERENCES caches(id)      ON DELETE CASCADE,
  landuse_id BIGINT NOT NULL REFERENCES osm_landuse(id) ON DELETE CASCADE,
  kind       TEXT   NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_id, landuse_id)
);
CREATE INDEX cache_landuse_cache_idx ON cache_landuse (cache_id);
CREATE INDEX cache_landuse_kind_idx  ON cache_landuse (kind);

-- Lazy populate: walk every (cache, landuse) pair where the cache lies in the
-- given bbox AND the polygon overlaps it. ON CONFLICT DO NOTHING keeps the
-- function idempotent — a region planned twice does not double-write.
-- Returns the number of new (cache, landuse) rows actually inserted.
CREATE OR REPLACE FUNCTION populate_cache_landuse_in_bbox(
  min_lng DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lng DOUBLE PRECISION,
  max_lat DOUBLE PRECISION
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  inserted BIGINT;
  bbox     GEOGRAPHY;
BEGIN
  bbox := ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography;
  WITH ins AS (
    INSERT INTO cache_landuse (cache_id, landuse_id, kind)
    SELECT c.id, l.id, l.kind
    FROM caches c
    JOIN osm_landuse l
      ON ST_Intersects(l.polygon, bbox)
     AND ST_Contains(l.polygon::geometry, c.location::geometry)
    WHERE ST_Intersects(c.location, bbox)
    ON CONFLICT (cache_id, landuse_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM ins;
  RETURN inserted;
END;
$$;


-- Down Migration

DROP FUNCTION IF EXISTS populate_cache_landuse_in_bbox(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
);
DROP TABLE IF EXISTS cache_landuse;
