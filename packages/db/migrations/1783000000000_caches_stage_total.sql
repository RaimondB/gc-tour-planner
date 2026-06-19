-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Adventure Lab stage total. Companion to the `stage_sequence` column added in
-- migration 1782000000000: stores how many stages the Adventure has in total, so
-- the UI can show "Stage N of M" and the tour view can tell whether a whole
-- Adventure is covered by a planned loop (N included vs M total). Sourced from
-- Lab2Gpx's `<lab2gpx:stagesTotal>`. NULL for every non-Adventure-Lab cache and
-- for AL rows imported before this column existed (a re-import backfills it).

-- Up Migration

ALTER TABLE caches
  ADD COLUMN stage_total SMALLINT;

COMMENT ON COLUMN caches.stage_total IS
  'Total stages in the Adventure this stage belongs to (Lab2Gpx stagesTotal). NULL for non-AL caches; drives "Stage N of M" + tour completion.';


-- Down Migration

ALTER TABLE caches
  DROP COLUMN IF EXISTS stage_total;
