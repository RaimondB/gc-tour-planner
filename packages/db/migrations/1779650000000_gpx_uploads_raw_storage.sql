-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Track raw GPX bytes stored on disk so we can reprocess uploads when new
-- parsed fields (next: `disabled`/`archived` filter) are added. The gzipped
-- XML is written to a docker volume at `/srv/uploads/{uploadId}.gpx.gz`;
-- the DB only carries the size + a checksum of the *uncompressed* XML for
-- integrity-on-reprocess and future dedupe.
--
-- Both columns are NULL when no raw file is stored — either because the
-- row predates this feature, or because the application disabled storage
-- for that upload. No backfill: existing rows stay NULL.
--
-- The `status` column now has three legal values (was two):
--   'received' — row written, raw file persisted, parse not yet attempted.
--   'parsed'   — XML parsed and caches upserted.
--   'failed'   — parse attempted and errored (see `error` column).
-- No DB CHECK constraint — the GpxService is the single writer and we want
-- to keep the door open for new states (e.g. 'reprocessing') without a
-- schema migration each time.
--
-- No new indexes: gpx_uploads stays tiny (< 1k rows lifetime) and all
-- lookups go through the existing PK or `gpx_uploads_owner_idx`.

-- Up Migration

ALTER TABLE gpx_uploads
  ADD COLUMN raw_size_bytes BIGINT,
  ADD COLUMN raw_sha256     TEXT;

COMMENT ON COLUMN gpx_uploads.raw_size_bytes IS
  'Size in bytes of the gzipped XML on disk at /srv/uploads/{id}.gpx.gz. NULL when no raw file is stored.';
COMMENT ON COLUMN gpx_uploads.raw_sha256 IS
  'Lowercase-hex SHA-256 of the uncompressed XML bytes (64 chars). NULL when no raw file is stored.';
COMMENT ON COLUMN gpx_uploads.status IS
  'Valid values: ''received'' | ''parsed'' | ''failed''. Enforced in application, not DB.';


-- Down Migration

ALTER TABLE gpx_uploads
  DROP COLUMN IF EXISTS raw_sha256,
  DROP COLUMN IF EXISTS raw_size_bytes;
