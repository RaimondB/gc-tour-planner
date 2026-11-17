-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Route profiles (FR-T19, ADR-0039): named planning presets shared by the
-- classic cluster planner and the ad-hoc walk.
--
-- Schema choices:
--   * `settings` is JSONB validated application-side by the versioned zod schema
--     `RouteProfileSettings` (packages/shared/src/route-profiles). Every field has
--     a default, so the seeds below only store what differs from the defaults.
--   * owner_id NULL = system preset: visible to everyone, read-only over the API.
--     Same scoping as landuse_profiles.
--   * Names are unique per owner, case-insensitive. System presets share one
--     namespace (COALESCE to the nil UUID); a user may reuse a preset's name.

-- Up Migration

CREATE TABLE route_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,    -- NULL = system preset
  name        TEXT NOT NULL,
  description TEXT,
  settings    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the list query (owner_id IS NULL OR owner_id = :userId) and the
-- per-owner name uniqueness check.
CREATE UNIQUE INDEX route_profiles_owner_name_uq
  ON route_profiles (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Stable ids so tests and the client can reference the presets directly.
INSERT INTO route_profiles (id, owner_id, name, description, settings) VALUES
  ('a0000000-0000-4000-8000-000000000001', NULL,
   'Quick traditionals',
   'Short and easy: traditionals up to D/T 2.5, about an hour.',
   '{"filters":{"types":["Traditional"],"difficulty":{"min":1,"max":2.5},"terrain":{"min":1,"max":2.5}},"adventures":{"include":false},"time":{"visitMinutes":3},"budget":{"distanceBudgetMeters":5000,"durationMinutes":60}}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', NULL,
   'Forest walk',
   'Any cache type, favouring forest, parks and nature; about three hours.',
   '{"objective":{"landuseProfileId":"11111111-1111-1111-1111-111111111111","landuseWeight":3},"budget":{"distanceBudgetMeters":8000,"durationMinutes":180}}'::jsonb),
  ('a0000000-0000-4000-8000-000000000003', NULL,
   'Adventure Lab day',
   'Favours Adventure Labs, each done completely; about three hours.',
   '{"adventures":{"include":true,"keepTogether":true},"objective":{"preferredTypes":["Adventure Lab"],"preferredWeight":3},"budget":{"distanceBudgetMeters":8000,"durationMinutes":180}}'::jsonb);


-- Down Migration

DROP TABLE IF EXISTS route_profiles;
