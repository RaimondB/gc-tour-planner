-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- M2: initial schema for cache ingest.
-- Tables for routing legs, OSM landuse, tours, and preference profiles land in
-- later milestones (M3..M6). See docs/DESIGN.md §1.

-- Up Migration

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE caches (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  code         TEXT NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  location     GEOGRAPHY(Point, 4326) NOT NULL,
  difficulty   NUMERIC(2,1),
  terrain      NUMERIC(2,1),
  size         TEXT,
  archived     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw          JSONB NOT NULL DEFAULT '{}'::jsonb
);
-- Per-owner uniqueness: same cache code from two different users does not collide.
-- A NULL owner_id (public-source rows, M7+) uses a partial unique index because
-- Postgres treats NULLs as distinct in a regular UNIQUE.
CREATE UNIQUE INDEX caches_owner_source_id_idx
  ON caches (owner_id, source, source_id)
  WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX caches_public_source_id_idx
  ON caches (source, source_id)
  WHERE owner_id IS NULL;
CREATE INDEX caches_location_gist ON caches USING GIST (location);
CREATE INDEX caches_owner_idx ON caches (owner_id);
CREATE INDEX caches_type_idx ON caches (type);

CREATE TABLE cache_attributes (
  cache_id BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  attr_id  INT NOT NULL,
  positive BOOLEAN NOT NULL,
  PRIMARY KEY (cache_id, attr_id, positive)
);
CREATE INDEX cache_attributes_attr_idx ON cache_attributes (attr_id, positive);

CREATE TABLE additional_waypoints (
  id        BIGSERIAL PRIMARY KEY,
  cache_id  BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  location  GEOGRAPHY(Point, 4326) NOT NULL,
  note      TEXT
);
CREATE INDEX additional_waypoints_location_gist ON additional_waypoints USING GIST (location);
CREATE INDEX additional_waypoints_cache_idx ON additional_waypoints (cache_id);

CREATE TABLE gpx_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  parsed_count INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  error        TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gpx_uploads_owner_idx ON gpx_uploads (owner_id);


-- Down Migration

DROP TABLE IF EXISTS gpx_uploads;
DROP TABLE IF EXISTS additional_waypoints;
DROP TABLE IF EXISTS cache_attributes;
DROP TABLE IF EXISTS caches;
DROP TABLE IF EXISTS users;
-- Extensions are left in place; dropping them can affect other databases on the cluster.
