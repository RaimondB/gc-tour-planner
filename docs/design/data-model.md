# Data model (Postgres + PostGIS)

Migrations live in `packages/db/migrations/` as plain SQL (`node-pg-migrate`). Kysely types are generated from the same schema.

## Core tables

```sql
-- 0001_init.sql (sketch)

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT,                          -- nullable: OAuth-only users
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE caches (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     UUID REFERENCES users(id) ON DELETE CASCADE,   -- nullable for public-source rows
  source       TEXT NOT NULL,                                 -- 'gpx', 'okapi:<node>', 'gc-com'
  source_id    TEXT NOT NULL,                                 -- e.g. cache code 'GC12345'
  code         TEXT NOT NULL,
  type         TEXT NOT NULL,                                 -- Traditional, Multi, Mystery, ...
  name         TEXT NOT NULL,
  location     GEOGRAPHY(Point, 4326) NOT NULL,
  difficulty   NUMERIC(2,1),
  terrain      NUMERIC(2,1),
  size         TEXT,
  archived     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, source_id, owner_id)
);
CREATE INDEX caches_location_gist ON caches USING GIST (location);
CREATE INDEX caches_owner_idx ON caches (owner_id);

CREATE TABLE cache_attributes (
  cache_id BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  attr_id  INT NOT NULL,                                      -- Groundspeak attribute id
  positive BOOLEAN NOT NULL,
  PRIMARY KEY (cache_id, attr_id, positive)
);

CREATE TABLE additional_waypoints (
  id        BIGSERIAL PRIMARY KEY,
  cache_id  BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,                                    -- 'parking', 'reference', 'stages', ...
  location  GEOGRAPHY(Point, 4326) NOT NULL,
  note      TEXT
);
CREATE INDEX additional_waypoints_location_gist ON additional_waypoints USING GIST (location);

-- ADR-0009 replaced the Overpass-fed osm_landuse with osm2pgsql-fed
-- landuse_polygons. ADR-0011 adds parking_facilities to the same import.
-- Both tables are populated by infra/osm2pgsql/osm-features.lua in a
-- single PBF pass, with freshness recorded in landuse_import_meta.
CREATE TABLE landuse_polygons (
  osm_id    BIGINT NOT NULL,                                  -- OSM way / relation id
  osm_type  CHAR(1) NOT NULL,                                 -- 'W' (way) | 'R' (relation), uppercase from osm2pgsql flex
  kind      TEXT NOT NULL,                                    -- 'forest', 'park', 'residential', ... (see packages/shared/src/landuse)
  geom      GEOMETRY(MultiPolygon, 4326) NOT NULL,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX landuse_polygons_geom_gix ON landuse_polygons USING GIST (geom);
CREATE INDEX landuse_polygons_kind_idx ON landuse_polygons (kind);

CREATE TABLE parking_facilities (                              -- ADR-0011
  osm_id        BIGINT NOT NULL,
  osm_type      CHAR(1) NOT NULL,                             -- 'N' | 'W' | 'R' (uppercase, osm2pgsql flex)
  geom          GEOMETRY NOT NULL,                            -- Point for nodes, MultiPolygon for ways/relations, 4326
  access        TEXT,                                         -- yes | customers | permit | private | no | …
  fee           TEXT,                                         -- normalised: parking:condition=disc → 'no'
  parking_type  TEXT,                                         -- surface | multi-storey | underground | …
  capacity      INTEGER,
  maxstay       TEXT,
  supervised    TEXT,
  opening_hours TEXT,
  surface       TEXT,
  name          TEXT,
  PRIMARY KEY (osm_type, osm_id)
);
CREATE INDEX parking_facilities_geom_gix    ON parking_facilities USING GIST (geom);
CREATE INDEX parking_facilities_access_idx  ON parking_facilities (access);
CREATE INDEX parking_facilities_fee_idx     ON parking_facilities (fee);

CREATE TABLE landuse_import_meta (                             -- single-row, CHECK id=1
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at   TIMESTAMPTZ NOT NULL,
  pbf_timestamp TIMESTAMPTZ,
  source_file   TEXT,
  replicated_at TIMESTAMPTZ,                                  -- legacy; replication queue dropped per ADR-0010
  replication_state TEXT
);

CREATE TABLE route_legs (
  from_cache_id BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  to_cache_id   BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  profile       TEXT NOT NULL,                                -- 'foot'
  meters        NUMERIC(10,2) NOT NULL,
  seconds       NUMERIC(10,2) NOT NULL,
  geom          GEOGRAPHY(LineString, 4326) NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_cache_id, to_cache_id, profile)
);

CREATE TABLE tours (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  start_point     GEOGRAPHY(Point, 4326) NOT NULL,
  parking_point   GEOGRAPHY(Point, 4326),
  cache_ids       BIGINT[] NOT NULL,
  total_meters    NUMERIC(10,2) NOT NULL,
  total_seconds   NUMERIC(10,2) NOT NULL,
  geom            GEOGRAPHY(LineString, 4326) NOT NULL,
  score_breakdown JSONB NOT NULL,
  share_slug      TEXT UNIQUE,                                -- nullable until shared
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tours_owner_idx ON tours (owner_id);

CREATE TABLE gpx_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  parsed_count INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,                                 -- 'pending', 'parsed', 'failed'
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE landuse_profiles (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id  UUID REFERENCES users(id) ON DELETE CASCADE,      -- NULL = system profile
  name      TEXT NOT NULL,
  weights   JSONB NOT NULL                                    -- {"forest":8,"park":4,"residential":-5}
);

CREATE TABLE preference_profiles (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 UUID REFERENCES users(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  attribute_weights        JSONB NOT NULL DEFAULT '{}'::jsonb,
  terrain_target           NUMERIC(2,1),
  difficulty_target        NUMERIC(2,1),
  time_per_cache_minutes   INT NOT NULL DEFAULT 5,
  weights                  JSONB NOT NULL DEFAULT '{}'::jsonb -- cluster, loop-compactness, etc.
);

CREATE TABLE cache_finds (
  cache_id  BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  user_id   UUID   NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  found_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source    TEXT   NOT NULL,        -- 'manual' | 'gpx-finds-import' | 'gc-com'
  PRIMARY KEY (cache_id, user_id)
);
CREATE INDEX cache_finds_user_idx ON cache_finds (user_id);
```

A separate table (not a `found` column on `caches`) so that public-source rows in M7+ — where `owner_id IS NULL` — can still carry per-user finds without ambiguity.

## Spatial helpers

- Radius search: `ST_DWithin(location, ST_MakePoint(:lng, :lat)::geography, :meters)` — uses the GIST index.
- Landuse context: `ST_Contains(landuse.polygon::geometry, caches.location::geometry)`.
- Tour polyline: assembled from `route_legs.geom` concatenated in visit order.
- Exclude-found filter: `NOT EXISTS (SELECT 1 FROM cache_finds f WHERE f.cache_id = c.id AND f.user_id = :userId)` — also used as a `foundByMe` boolean in the projection so the UI can dim still-shown found markers.

## Row-level access

User-uploaded GPX caches have `owner_id` set. Source-adapter rows (OKAPI / GC.com) have `owner_id = NULL` and are world-readable. Repository methods take an explicit `userId` and union `(owner_id = :userId OR owner_id IS NULL)`. No Postgres RLS — enforced in the data layer because it's read-heavy and an `owner_id IS NULL` shortcut is faster than a row-by-row policy check. The `cache_finds` table follows the same pattern: every find query filters by `user_id` in the data layer.
