-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- PR2 — "upload UX gets meaningful": surface Groundspeak's `available` flag
-- and the PQ export timestamp on caches, plus the export timestamp on the
-- upload row itself. Adds the partial composite index the map's default
-- listCaches query depends on.
--
-- Columns added
-- -------------
-- caches.disabled
--   Groundspeak distinguishes a temporarily disabled cache (owner is fixing
--   it; `available="False" archived="False"`) from a permanently archived
--   one (`archived="True"`). We mirror that distinction in the DB because
--   the map renders them differently — `archived` is hidden by default,
--   `disabled` is shown with a "Z" (sleeping) overlay so planners can still
--   route around them. Collapsing the two into `archived` would lose that
--   UX signal. Default FALSE: pre-PR2 rows we don't have the flag for stay
--   on the optimistic side; the operator can back-fill by re-running
--   `POST /admin/uploads/:id/reprocess` against historic uploads (we kept
--   the raw GPX bytes precisely so this is cheap — see migration
--   1779650000000).
--
-- caches.source_exported_at
--   The `<gpx><time>` of the PQ that last wrote this row. Used by the
--   upsert's staleness guard: an upload whose `exported_at` is older than
--   the row's current `source_exported_at` skips writing that cache so a
--   stale PQ replayed against a more recent dataset can't downgrade fresh
--   data. NULLABLE rather than `NOT NULL DEFAULT now()` because pre-PR2
--   rows have no provenance — defaulting to now() would actively lie
--   ("this came from a PQ exported at deploy time") and defeat the guard.
--   NULL is treated by the guard as "older than anything", so the next
--   upload always wins, which is the behaviour we want.
--
-- gpx_uploads.exported_at
--   The `<gpx><time>` of the PQ itself, captured at parse time. For PR2+
--   rows the parser copies this onto every upserted cache's
--   `source_exported_at`. NULL when the GPX had no `<gpx><time>` element
--   (rare — Groundspeak always emits one, but third-party tools may not);
--   tolerable because the staleness guard degenerates safely on NULL.
--
-- Index added
-- -----------
--   CREATE INDEX caches_owner_active_idx
--     ON caches (owner_id)
--     WHERE NOT archived AND NOT disabled;
--
-- Supports the map's hot path:
--   SELECT … FROM caches
--     WHERE owner_id = $1
--       AND NOT archived
--       AND NOT disabled
--       AND ST_DWithin(location, $2, $3);
--
-- A partial index keyed on owner_id is intentionally tiny — the vast
-- majority of caches are active, so the partial predicate barely shrinks
-- the row set but it does shrink each index entry (no boolean payload)
-- and, more importantly, lets the planner BitmapAnd this with the
-- existing GIST `caches_location_gist` for the spatial clause without
-- a separate recheck of the two booleans. The pre-existing
-- `caches_owner_idx` (non-partial) stays — it serves owner-scoped
-- writes/upserts that intentionally see archived/disabled rows.

-- Up Migration

ALTER TABLE caches
  ADD COLUMN disabled            BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN source_exported_at  TIMESTAMPTZ;

COMMENT ON COLUMN caches.disabled IS
  'Cache owner has temporarily disabled the cache (Groundspeak `available="False" archived="False"`). Distinct from `archived` (permanent). Default FALSE for pre-PR2 rows; reprocess past uploads via POST /admin/uploads/:id/reprocess to back-fill.';
COMMENT ON COLUMN caches.source_exported_at IS
  'The <gpx><time> of the upload that last wrote this row. NULL means pre-PR2 (provenance unknown). Used by the upsert staleness guard.';

ALTER TABLE gpx_uploads
  ADD COLUMN exported_at TIMESTAMPTZ;

COMMENT ON COLUMN gpx_uploads.exported_at IS
  'The <gpx><time> of the PQ (when Groundspeak generated it). NULL when the GPX had no <gpx><time> element. Copied onto each upserted cache.source_exported_at.';

-- Map listCaches hot path: WHERE owner_id = ? AND NOT archived AND NOT disabled AND ST_DWithin(...)
CREATE INDEX IF NOT EXISTS caches_owner_active_idx
  ON caches (owner_id)
  WHERE NOT archived AND NOT disabled;


-- Down Migration

DROP INDEX IF EXISTS caches_owner_active_idx;

ALTER TABLE gpx_uploads
  DROP COLUMN IF EXISTS exported_at;

ALTER TABLE caches
  DROP COLUMN IF EXISTS source_exported_at,
  DROP COLUMN IF EXISTS disabled;
