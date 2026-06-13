-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- M6-γ (FR-P1/FR-P2): persist planned tours. One row per saved tour, owner-scoped
-- (owner_id → users, ON DELETE CASCADE so deleting a user reaps their tours).
--
-- Two kinds of columns by design (see docs/design/data-model.md + auth-and-sharing.md §8):
--   * Typed columns (name, start_point, parking_point, cache_ids, total_meters,
--     total_seconds, geom, score_breakdown) back listing/sorting and spatial
--     queries without parsing JSON.
--   * `plan` JSONB holds the full in-memory PlanResult verbatim (legs, dropped
--     caches, parking choice) PLUS a denormalised cache snapshot, so a saved
--     tour re-renders WITHOUT re-planning and the future public shared view
--     (M6-δ, GET /shared/:slug) never reads owner-scoped cache tables (ADR-0022).
--
-- `share_slug` is created here (nullable, UNIQUE) but stays NULL until M6-δ mints
-- one — the UNIQUE constraint provides the slug-lookup index that view will use.
--
-- tours_owner_idx backs the owner-scoped `GET /tours` list query (WHERE owner_id
-- = $current, ORDER BY created_at DESC).

-- Up Migration

CREATE TABLE tours (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  start_point     GEOGRAPHY(Point, 4326) NOT NULL,
  parking_point   GEOGRAPHY(Point, 4326),
  cache_ids       BIGINT[] NOT NULL,
  total_meters    NUMERIC(10, 2) NOT NULL,
  total_seconds   NUMERIC(10, 2) NOT NULL,
  geom            GEOGRAPHY(LineString, 4326) NOT NULL,
  score_breakdown JSONB NOT NULL,
  plan            JSONB NOT NULL,
  share_slug      TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tours_owner_idx ON tours (owner_id);

-- Down Migration

DROP TABLE IF EXISTS tours;
