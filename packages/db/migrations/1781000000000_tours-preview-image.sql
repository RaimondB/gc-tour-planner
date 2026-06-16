-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Add a client-captured map snapshot to saved tours (FR-P1/FR-P2 follow-up).
--
-- The web client captures a WebP image of the saved tour's map (basemap +
-- route overlay) and uploads it with the tour. It is shown offline (no tiles)
-- and as the list thumbnail, so the saved-tours list and an offline detail view
-- render without MapLibre or network tiles.
--
-- Both columns are nullable: existing rows have no snapshot until a future
-- backfill (or the next save) populates them. `preview_mime` records the image
-- type the app wrote (`image/webp`). No index needed — the bytes are only read
-- by id alongside the rest of the row.

-- Up Migration

ALTER TABLE tours ADD COLUMN preview_image BYTEA;
ALTER TABLE tours ADD COLUMN preview_mime TEXT;

-- Down Migration

ALTER TABLE tours DROP COLUMN IF EXISTS preview_image;
ALTER TABLE tours DROP COLUMN IF EXISTS preview_mime;
