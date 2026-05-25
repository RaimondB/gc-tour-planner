-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Tag every cached leg with the OSRM extract version that produced it. When
-- the operator rebuilds the foot graph (new PBF, refreshed Geofabrik extract),
-- existing rows carry the previous version's hash and the read path filters
-- them out automatically — forcing a one-time re-fetch into the new version.
--
-- The bootstrap script writes the hash (first 16 hex of sha256(PBF)) to
-- /data/osrm-version.txt; the API reads it at boot and on each plan call.
-- Rows that predate this migration get `'unknown'` and are also filtered out
-- once the running extract publishes its real version, which is exactly the
-- behaviour we want.


-- Up Migration

ALTER TABLE route_legs
  ADD COLUMN osrm_version TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX route_legs_profile_version_idx
  ON route_legs (profile, osrm_version);


-- Down Migration

DROP INDEX IF EXISTS route_legs_profile_version_idx;
ALTER TABLE route_legs DROP COLUMN IF EXISTS osrm_version;
