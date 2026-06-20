-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Adventure Lab metadata columns.
--
-- Adventure Lab "caches" are the individual stages of a Groundspeak Adventure.
-- They enter the system as ordinary cache rows (type='Adventure Lab') but carry
-- three pieces of adventure-level metadata the generic cache shape can't express:
--
--   adventure_id          The adventure's deep-link GUID — the path segment of
--                         https://labs.geocaching.com/goto/<adventure_id>. All
--                         stages of one Adventure share it, so it doubles as a
--                         grouping key AND lets the UI link out to the Adventure
--                         in the Lab app (there is no per-stage geocaching.com
--                         page, and a stage's code is a Lab2Gpx-synthetic id, not
--                         a real GC code). NOTE: this is the DeepLink GUID, NOT
--                         the AL API's adventure Id — only the former resolves on
--                         the /goto/ endpoint.
--   stage_sequence        1-based position of the stage within its Adventure.
--                         Reserved for "Stage N of M" display + sequential
--                         routing; populated by the later cluster-enrichment work.
--   adventure_sequential  TRUE when the Adventure must be done in stage order
--                         (the AL `IsLinear` flag). Reserved for the planner's
--                         sequential-ordering pass.
--
-- All three are NULL for every non-Adventure-Lab row (the overwhelming majority),
-- so they're plain nullable columns — no default, no back-fill. The partial index
-- supports "give me all stages of adventure X" without bloating the index with the
-- NULLs.

-- Up Migration

ALTER TABLE caches
  ADD COLUMN adventure_id         TEXT,
  ADD COLUMN stage_sequence       SMALLINT,
  ADD COLUMN adventure_sequential BOOLEAN;

COMMENT ON COLUMN caches.adventure_id IS
  'Adventure Lab deep-link GUID (path segment of labs.geocaching.com/goto/<id>). Shared by all stages of one Adventure; NULL for non-AL caches. This is the DeepLink GUID, not the AL API adventure Id.';
COMMENT ON COLUMN caches.stage_sequence IS
  '1-based stage position within an Adventure Lab. NULL for non-AL caches.';
COMMENT ON COLUMN caches.adventure_sequential IS
  'TRUE when the Adventure Lab must be completed in stage order (AL IsLinear). NULL for non-AL caches.';

CREATE INDEX IF NOT EXISTS caches_adventure_id_idx
  ON caches (adventure_id)
  WHERE adventure_id IS NOT NULL;


-- Down Migration

DROP INDEX IF EXISTS caches_adventure_id_idx;

ALTER TABLE caches
  DROP COLUMN IF EXISTS adventure_sequential,
  DROP COLUMN IF EXISTS stage_sequence,
  DROP COLUMN IF EXISTS adventure_id;
