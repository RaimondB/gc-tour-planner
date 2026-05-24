-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Per-user "found" log. A separate table (not a column on caches) so that
-- public-source rows in M7+ — where owner_id IS NULL — can still carry
-- per-user finds without ambiguity.

-- Up Migration

CREATE TABLE cache_finds (
  cache_id BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  user_id  UUID   NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source   TEXT   NOT NULL,
  PRIMARY KEY (cache_id, user_id)
);

CREATE INDEX cache_finds_user_idx ON cache_finds (user_id);


-- Down Migration

DROP TABLE IF EXISTS cache_finds;
