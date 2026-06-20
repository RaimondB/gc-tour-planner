-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- One-time cleanup (FR-I17): remove duplicate Adventure Lab stage rows. The same
-- adventure was imported under two Lab2Gpx code schemes — with a stage separator
-- ("LC1AP4-1") and without ("LC1AP41") — producing two rows per stage that share
-- (owner_id, adventure_id, stage_sequence) and coordinates but differ in
-- code/source_id, so the (source, source_id) upsert dedup never caught them. The
-- result is every affected adventure showing twice its real stage count and the
-- "complete adventures only" rule counting 2× the stages.
--
-- Keep exactly one row per logical stage, preferring the NON-hyphenated code (the
-- enricher's current `stageSeparator: false` scheme, so a later re-fetch dedups
-- by source_id), then the lowest id. All FKs to `caches` are ON DELETE CASCADE,
-- so dependent attributes / waypoints / route_legs / precompute rows are removed
-- with the duplicate; verified none of the deleted rows carry cache_finds.

-- Up Migration

DELETE FROM caches c
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY owner_id, adventure_id, stage_sequence
           ORDER BY (code ~ '-[0-9]+$') ASC, id ASC
         ) AS rn
  FROM caches
  WHERE type = 'Adventure Lab'
    AND adventure_id IS NOT NULL
    AND adventure_id <> ''
    AND stage_sequence IS NOT NULL
) dup
WHERE c.id = dup.id
  AND dup.rn > 1;


-- Down Migration

-- Irreversible: the deleted duplicate rows cannot be reconstructed. Re-running
-- the Adventure Lab import re-creates any genuinely-needed stages from Lab2Gpx.
SELECT 1;
