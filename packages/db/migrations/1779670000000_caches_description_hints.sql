-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- PR3 — "smart filtering & planner tool-awareness" (FR-F8).
--
-- Adds `caches.description_hints text[]`: a parsed, normalised set of "tool
-- hint" keys (e.g. 'fishingRod', 'binoculars', 'magnet', 'tweezers',
-- 'ladder', 'mirror') produced by the parser's `scanDescriptionHints`
-- function over the cache's short + long description text. The scanner
-- runs against an en/nl/de seed dictionary; the column stores the
-- canonical keys (language-independent) so the web app can render them
-- with the right locale.
--
-- (a) Why NULLABLE rather than `NOT NULL DEFAULT '{}'`:
--     We deliberately want THREE states, not two:
--       NULL                    = description was never scanned (pre-PR3
--                                 row, or scan was skipped). Operator can
--                                 back-fill via
--                                 `POST /admin/uploads/:id/reprocess`
--                                 (FR-I9).
--       '{}'::text[]            = description WAS scanned but no hints
--                                 matched.
--       '{fishingRod, ...}'     = description was scanned and matched at
--                                 least one entry.
--     Collapsing NULL into '{}' would lose the "needs back-filling" signal
--     — the admin dashboard would no longer be able to count caches still
--     waiting on a reprocess.
--
-- (b) Why no index:
--     The column is part of the `listCaches` SELECT projection only and is
--     never used in a WHERE clause. Filtering on tool hints happens
--     client-side in the web app (the cache set the user has just been
--     served is already small enough to filter in-memory). No GIN/GIST
--     needed — adding one would be dead weight on every upsert.
--
-- (c) Tracks FR-F8 in the requirements doc (docs/requirements/filtering.md
--     after this PR lands; grep "FR-F8" for context).

-- Up Migration

ALTER TABLE caches
  ADD COLUMN description_hints TEXT[];

COMMENT ON COLUMN caches.description_hints IS
  'FR-F8: canonical tool-hint keys (e.g. fishingRod, binoculars, magnet, tweezers, ladder, mirror) extracted by scanDescriptionHints() from the cache description. THREE-state nullability: NULL = never scanned (back-fill via POST /admin/uploads/:id/reprocess), ''{}'' = scanned, no hints matched, non-empty = scanned, hints found. No index — SELECT projection only, filtering is client-side.';


-- Down Migration

ALTER TABLE caches
  DROP COLUMN IF EXISTS description_hints;
