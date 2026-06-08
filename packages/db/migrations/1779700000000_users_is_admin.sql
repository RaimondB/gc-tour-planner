-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- FR-P12: add the `is_admin` role flag to users. Until now `/admin/*` and the
-- destructive planner-maintenance routes were "admin = any authenticated user"
-- (the role was a documented-but-unbuilt hook). This column is the hook; an
-- AdminGuard in the API enforces it. Defaults FALSE, so NO user is an admin
-- until an operator promotes one explicitly (secure default):
--
--   UPDATE users SET is_admin = TRUE WHERE email = '<operator-email>';
--
-- No index: the flag is read via the user's primary-key lookup at session
-- establishment, never filtered on its own.

-- Up Migration

ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration

ALTER TABLE users DROP COLUMN is_admin;
