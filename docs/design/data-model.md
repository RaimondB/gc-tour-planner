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
  -- The EFFECTIVE coordinate the planner uses: a user-supplied solved
  -- coordinate when solved=TRUE, otherwise the posted coordinate. ALL spatial
  -- queries (radius, clustering, walking-graph, landuse) read this column, so
  -- the FR-I13 solved-coords feature lands entirely on the upload path.
  location     GEOGRAPHY(Point, 4326) NOT NULL,
  -- FR-I13: the raw coordinate from the most recent Pocket Query (original
  -- posted coord). A normal PQ refreshes it but only writes `location` when
  -- NOT solved; a solved upload writes `location` + solved and never touches
  -- this. NULL only for caches first seen via a solved upload. Lets "remove
  -- solved coordinates" revert location = COALESCE(published_location, location).
  published_location GEOGRAPHY(Point, 4326),
  -- FR-I13: TRUE when `location` holds a user-supplied solved/corrected coord
  -- (Mystery solution or Multi final), set via a solvedCoordinates upload.
  solved       BOOLEAN NOT NULL DEFAULT FALSE,
  solved_at    TIMESTAMPTZ,
  difficulty   NUMERIC(2,1),
  terrain      NUMERIC(2,1),
  size         TEXT,
  archived     BOOLEAN NOT NULL DEFAULT FALSE,
  -- FR-I10: temp-disabled by owner (Groundspeak: available="False"
  -- with archived="False"). Distinct from archived. Map renders at
  -- 50 % opacity with a "Z" overlay when shown.
  disabled     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FR-I10 staleness guard: the <gpx><time> of the upload that last
  -- wrote this row. NULL = pre-PR2 (provenance unknown, guard treats
  -- as "always allow update").
  source_exported_at TIMESTAMPTZ,
  -- Adventure Lab metadata (NULL for every non-Adventure-Lab cache). A stage of
  -- an Adventure enters as type='Adventure Lab'; these carry the adventure-level
  -- facts the generic shape can't. adventure_id is the DEEP-LINK GUID (path
  -- segment of labs.geocaching.com/goto/<id>) — shared by all stages of one
  -- Adventure, so it groups them AND drives the "open in Adventure Lab" link
  -- (note: NOT the AL API adventure Id; only the deep-link GUID resolves on
  -- /goto/). stage_sequence (1-based, from <urlname> "S{n}") + stage_total (from
  -- <lab2gpx:stagesTotal>) drive the numbered "S{n}" map label, the popup
  -- "Stage N of M", and the per-tour completion check. adventure_sequential
  -- (IsLinear) is reserved for the planner's sequential-ordering pass.
  adventure_id         TEXT,
  stage_sequence       SMALLINT,
  stage_total          SMALLINT,
  adventure_sequential BOOLEAN,
  raw          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, source_id, owner_id)
);
CREATE INDEX caches_location_gist ON caches USING GIST (location);
CREATE INDEX caches_owner_idx ON caches (owner_id);
-- Partial index supporting the listCaches default WHERE clause
-- (NOT archived AND NOT disabled). Combines with caches_location_gist
-- in a BitmapAnd for the spatial part. Empty for owners whose caches
-- are all archived/disabled — tiny on the common case.
CREATE INDEX caches_owner_active_idx
  ON caches (owner_id)
  WHERE NOT archived AND NOT disabled;
-- FR-I13: partial index for the "only solved mysteries" filter
-- (WHERE NOT (type='Mystery' AND solved=false)). Solved caches are rare,
-- so the partial index stays tiny.
CREATE INDEX caches_owner_solved_idx
  ON caches (owner_id)
  WHERE solved;
-- "All stages of adventure X" lookup (grouping / completion). Partial — only
-- Adventure Lab rows have a non-NULL adventure_id.
CREATE INDEX caches_adventure_id_idx
  ON caches (adventure_id)
  WHERE adventure_id IS NOT NULL;

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
-- landuse_polygons. ADR-0011 adds parking_facilities and ADR-0012 adds
-- car_roads to the same import. All three tables are populated by
-- infra/osm2pgsql/osm-features.lua in a single PBF pass, with freshness
-- recorded in landuse_import_meta.
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

CREATE TABLE car_roads (                                      -- ADR-0012
  osm_id        BIGINT PRIMARY KEY,                           -- ways only (no osm_type)
  geom          GEOMETRY(LineString, 4326) NOT NULL,          -- open ways
  highway       TEXT NOT NULL,                                -- residential | living_street | unclassified | service | tertiary
  access        TEXT,                                         -- fine filter: drop no | private
  motor_vehicle TEXT,                                         -- fine filter: drop no | private
  maxspeed_kmh  INTEGER,                                      -- pre-parsed; fine filter drops ≥ 70 (NULL kept)
  service       TEXT,                                         -- fine filter: drop 'driveway'
  name          TEXT
);
CREATE INDEX car_roads_geom_gix    ON car_roads USING GIST (geom);
CREATE INDEX car_roads_highway_idx ON car_roads (highway);
-- Coarse highway class filter applied in the osm2pgsql Lua; the fine filter
-- (access/motor_vehicle/maxspeed/service) runs at query time in
-- CarRoadsRepository so it's retunable without a re-import. Snapped via
-- ST_ClosestPoint for `osrm-nearest-road` tour-start parking.

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

-- MIGRATED in M6-γ (packages/db/migrations/1779730000000_tours.sql) with the
-- `plan JSONB` column added below holding StoredPlan (PlanResult + cache
-- snapshot), so a saved tour re-renders without re-planning (FR-P1). See
-- design/auth-and-sharing.md §8. The UNIQUE on share_slug provides the
-- slug-lookup index; tours_owner_idx backs the per-user list.
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
  -- Full in-memory PlanResult stored verbatim (legs, dropped caches, parking
  -- choice) + a denormalised cache snapshot for the public shared view, so
  -- GET /shared/:slug never reads owner-scoped cache tables (ADR-0022).
  plan            JSONB NOT NULL,
  share_slug      TEXT UNIQUE,                                -- nullable until shared
  -- Client-captured WebP map snapshot (basemap + route overlay), added in the
  -- M6.5 PWA work (1781000000000_tours-preview-image.sql, FR-W4). Shown offline
  -- and as the My-Tours thumbnail; served owner-scoped via GET /tours/:id/preview.
  preview_image   BYTEA,                                      -- nullable until captured/backfilled
  preview_mime    TEXT,                                       -- 'image/webp'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tours_owner_idx ON tours (owner_id);

-- No sessions table: M6 stores sessions in Valkey (ADR-0021). Only the
-- stateless-JWT-with-denylist alternative would add a table here.

CREATE TABLE gpx_uploads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  parsed_count   INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,                                 -- 'received', 'parsed', 'failed'
  error          TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Raw GPX bytes preservation (migration 1779650000000). NULL when
  -- no raw file is stored (rows predating the feature, or storage
  -- failure path). When set, the gzipped XML lives at
  -- `{UPLOADS_DIR}/{id}.gpx.gz` — see docker volume `gctp-uploads`.
  -- raw_sha256 (SHA-256 of the *uncompressed* XML) also backs the
  -- FR-I12 upload dedup: a re-upload whose hash matches this owner's
  -- newest status='parsed' row is skipped (no re-store/re-parse). No
  -- dedicated index — gpx_uploads stays tiny (< 1k rows lifetime).
  raw_size_bytes BIGINT,
  raw_sha256     TEXT,
  -- FR-I10: top-level <gpx><time> of the PQ (when Groundspeak
  -- generated it). NULL if absent. Copied onto each upserted cache's
  -- source_exported_at so the staleness guard can compare.
  exported_at    TIMESTAMPTZ
);

-- FR-SF8 (migration 1779670000000): description_hints stores the keys
-- returned by `scanDescriptionHints` over the cache's short+long
-- description text. THREE-state nullability is intentional:
--   NULL      = never scanned (pre-PR3 row; back-fill via
--               POST /admin/uploads/:id/reprocess)
--   '{}'      = scanned, no hints matched
--   non-empty = scanned, hints found (e.g. {'fishingRod','binoculars'})
-- No index — column is SELECT-projected only; filtering happens
-- client-side after fetch.
ALTER TABLE caches ADD COLUMN description_hints TEXT[];

-- FR-I13 (migration 1779710000000): solved / corrected coordinates.
-- Invariant: `location` is the coordinate the planner uses and is
-- AUTHORITATIVE once solved — a non-solved upload (a routine PQ) writes
-- only `published_location` + metadata and NEVER overwrites a solved
-- `location`; a solved upload (solvedCoordinates=true) writes `location` +
-- solved + solved_at and NEVER overwrites `published_location`. The two
-- modes touch disjoint coordinate columns, so they can't clobber each other
-- and solved uploads bypass the FR-I10 staleness guard. Because changing the
-- solved coordinate MOVES the cache, the upsert (and the
-- DELETE /caches/:id/solved-coordinates revert) invalidate that cache's
-- route_legs + cache_landuse in the same transaction so the walking-precompute
-- re-warm recomputes them (the precompute's freshness filter would otherwise
-- skip the stale legs).
ALTER TABLE caches
  ADD COLUMN published_location GEOGRAPHY(Point, 4326),
  ADD COLUMN solved             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN solved_at          TIMESTAMPTZ;
UPDATE caches SET published_location = location;  -- back-fill: today location == posted

-- FR-SF1: stage_count is NOT a column — it's computed via a sibling
-- subquery in caches.repository.ts:
--   (SELECT COUNT(*)::int FROM additional_waypoints w
--    WHERE w.cache_id = c.id AND w.type = 'stages') AS stage_count
-- Uses the existing additional_waypoints_cache_idx; no new index.

CREATE TABLE landuse_profiles (                                -- M5-β
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,    -- NULL = system profile
  name        TEXT NOT NULL,
  description TEXT,
  -- Canonical kinds the profile rewards. Must be a subset of
  -- packages/shared/src/landuse LANDUSE_KINDS (validated app-side).
  -- Per-kind weights are deferred; today every kind in the set
  -- counts equally toward the cluster's `landuseMatch` term.
  kinds       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX landuse_profiles_owner_idx ON landuse_profiles (owner_id);
-- Three seed system profiles ship with the migration:
--   Forest-heavy (forest, park, scrub, heath)
--   Urban        (residential, industrial)
--   Balanced     (forest, park, meadow, heath, scrub, residential, farmland)

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
