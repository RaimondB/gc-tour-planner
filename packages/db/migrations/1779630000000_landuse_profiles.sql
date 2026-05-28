-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- M5-β: surface the landuse-weighted soft preference. The planner already
-- consumes a `landuseProfileId` on PlanInput; this migration finally
-- gives it a table to look up.
--
-- Schema choices:
--   * Single-table design — profile id, name, kinds (JSONB array of
--     canonical LANDUSE_KINDS). Weights deferred: the planner's
--     `landuseMatch` term currently treats all preferred kinds equally
--     (fraction of caches in any preferred polygon). Per-kind weights
--     can be added later by widening the JSON shape to {kind: weight}.
--   * owner_id is nullable: NULL = system-seeded profile that every
--     user sees. Users can create their own profiles later (UI not in
--     this round).
--   * Three system profiles seeded — forest-heavy, urban, balanced —
--     covering the most common cacher preferences without going
--     overboard. The names are user-visible.

-- Up Migration

CREATE TABLE landuse_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,    -- NULL = system profile
  name        TEXT NOT NULL,
  description TEXT,
  -- Canonical kinds the profile rewards. Must be a subset of
  -- packages/shared/src/landuse LANDUSE_KINDS; enforced application-side
  -- to keep the DB schema flexible (new kinds shouldn't require a
  -- migration on the seeds).
  kinds       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup index for the per-user profile list (owner_id IS NULL OR
-- owner_id = :userId). System-only is the M5-β default.
CREATE INDEX landuse_profiles_owner_idx ON landuse_profiles (owner_id);

-- Three seed profiles. Stable UUIDs so the planner / tests can reference
-- them without a round-trip to fetch ids.
INSERT INTO landuse_profiles (id, owner_id, name, description, kinds) VALUES
  ('11111111-1111-1111-1111-111111111111', NULL,
   'Forest-heavy',
   'Reward caches sitting in forest, park, or nature-reserve polygons.',
   '["forest","park","scrub","heath"]'::jsonb),
  ('22222222-2222-2222-2222-222222222222', NULL,
   'Urban',
   'Reward caches inside residential or industrial polygons.',
   '["residential","industrial"]'::jsonb),
  ('33333333-3333-3333-3333-333333333333', NULL,
   'Balanced',
   'Equal credit for any green-space or built-up kind.',
   '["forest","park","meadow","heath","scrub","residential","farmland"]'::jsonb);


-- Down Migration

DROP TABLE IF EXISTS landuse_profiles;
