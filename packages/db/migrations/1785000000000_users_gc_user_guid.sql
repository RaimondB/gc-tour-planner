-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Per-user Geocaching account GUID (FR-I19). Lab2Gpx accepts a `userGuid` in its
-- /download request and, when supplied, returns each Adventure Lab's completion
-- state (the `CompletedGeocachesCount` aggregate + `<sym>Geocache Found</sym>` on
-- fully-completed adventures). We store the user's public GC GUID so AL
-- enrichment can fetch completeness and cross off finished adventures.
--
-- This is NOT a credential — a GC user GUID is public (it appears in profile
-- URLs) and Lab2Gpx is unauthenticated — so storing it in the DB is fine (it is
-- not an API key; cf. the env-only third-party key rule). NULL = not set.

-- Up Migration

ALTER TABLE users
  ADD COLUMN gc_user_guid TEXT;

COMMENT ON COLUMN users.gc_user_guid IS
  'Public Geocaching account GUID, passed to Lab2Gpx as userGuid to fetch Adventure Lab completion. NULL when unset. Not a credential.';


-- Down Migration

ALTER TABLE users
  DROP COLUMN IF EXISTS gc_user_guid;
