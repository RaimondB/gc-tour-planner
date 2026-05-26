-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Per-(cache, kind) precompute freshness. Tracks the lifecycle of background
-- jobs that warm `route_legs` (kind='walking') and `osm_landuse` (kind='landuse')
-- on GPX upload (see docs/design/precompute.md and ADR-0007). The admin
-- endpoint `/admin/precompute/retrigger-stale` joins against `v_stale_caches`
-- below to find rows worth re-enqueueing without purging the whole cache.
--
-- Why a separate table instead of columns on `caches`:
--   * Multiple precompute kinds per cache with independent state.
--   * Keeps the hot `caches` table lean.
--   * Stale lookups are a single indexed query, no scan of `caches`.
--
-- The `v_stale_caches` view is the single source of truth for "this cache
-- needs (re-)precompute". The housekeeping job and the admin endpoint must
-- both go through the view so they can't drift.


-- Up Migration

CREATE TYPE precompute_kind  AS ENUM ('walking', 'landuse');
CREATE TYPE precompute_state AS ENUM ('pending', 'in_progress', 'fresh', 'failed');

CREATE TABLE cache_precompute_state (
  cache_id      BIGINT          NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  kind          precompute_kind NOT NULL,
  state         precompute_state NOT NULL,
  -- Stamp of the OSRM extract this row was last successfully fetched against.
  -- NULL for kind='landuse' (Overpass has no equivalent version concept) and
  -- for any row that has never reached 'fresh' yet.
  osrm_version  TEXT,
  fetched_at    TIMESTAMPTZ,
  error_text    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_id, kind)
);

-- Supports the stale-row scan that the admin summary and retrigger-stale
-- endpoints both run on every page load.
CREATE INDEX cache_precompute_state_stale_idx
  ON cache_precompute_state (kind, state, osrm_version);


-- Stale-row view. Definition kept here so the admin endpoint and the
-- housekeeping job query the same logic. Includes:
--   * rows in non-terminal state (pending / in_progress / failed)
--   * walking rows whose osrm_version mismatches the supplied :current_version
--     (the view itself does not know the current version; callers WHERE-filter
--     on `osrm_version_mismatch` after binding their value)
--   * rows older than the caller-supplied TTL (same pattern)
--   * caches that have no row for a given kind (never precomputed)
CREATE VIEW v_cache_precompute_state AS
SELECT
  c.id AS cache_id,
  k.kind,
  s.state,
  s.osrm_version,
  s.fetched_at,
  s.error_text,
  s.updated_at,
  (s.cache_id IS NULL) AS missing
FROM caches c
CROSS JOIN (
  SELECT 'walking'::precompute_kind AS kind
  UNION ALL
  SELECT 'landuse'::precompute_kind
) k
LEFT JOIN cache_precompute_state s
  ON s.cache_id = c.id AND s.kind = k.kind;


-- Down Migration

DROP VIEW IF EXISTS v_cache_precompute_state;
DROP INDEX IF EXISTS cache_precompute_state_stale_idx;
DROP TABLE IF EXISTS cache_precompute_state;
DROP TYPE  IF EXISTS precompute_state;
DROP TYPE  IF EXISTS precompute_kind;
