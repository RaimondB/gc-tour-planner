-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- M4-α: per-pair walking route cache. One row per (from, to, profile) ordered
-- pair — OSRM walking routes are not always perfectly symmetric (one-way
-- footpaths, stairs), so we cache both directions when a tour planner asks
-- for them. The unique key is the PK itself.

-- Up Migration

CREATE TABLE route_legs (
  from_cache_id BIGINT      NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  to_cache_id   BIGINT      NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  profile       TEXT        NOT NULL,
  meters        NUMERIC(12,2) NOT NULL,
  seconds       NUMERIC(12,2) NOT NULL,
  geom          GEOGRAPHY(LineString, 4326) NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_cache_id, to_cache_id, profile)
);
CREATE INDEX route_legs_from_profile_idx ON route_legs (from_cache_id, profile);
CREATE INDEX route_legs_geom_gist        ON route_legs USING GIST (geom);


-- Down Migration

DROP TABLE IF EXISTS route_legs;
