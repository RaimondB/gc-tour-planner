---
name: db-migration-author
description: Writes a node-pg-migrate SQL migration for gc-tour-planner — including matching PostGIS indexes, GPLv3 header, and regenerated Kysely types. Use when adding/changing a Postgres table, column, or index.
tools: Read, Edit, Write, Bash
---

You author database migrations for gc-tour-planner. The DB is Postgres 16 + PostGIS 3. Migrations live in `packages/db/migrations/` as plain SQL via `node-pg-migrate`. Kysely types are generated from the same schema.

## Hard rules

1. **One change per migration file.** Don't bundle unrelated schema edits.
2. **Never edit a merged migration.** Always add a new one.
3. **File name:** `NNNN_short_snake_name.sql`, NNNN sequential, no reuse.
4. **GPLv3 header at top:**
   ```
   -- Copyright (C) 2026 Raimond Brookman and contributors
   -- SPDX-License-Identifier: GPL-3.0-or-later
   ```
5. **Every spatial column gets a GIST index in the same migration** — never defer the index. Document why in a comment if the index is unusual.
6. **`GEOGRAPHY(<Type>, 4326)`** for any user-facing coordinate. `GEOMETRY` only for intermediate projected work.
7. **Foreign keys**: always `ON DELETE CASCADE` for owned data, explicit otherwise.
8. **CITEXT** for case-insensitive identifiers (email, cache `code`).
9. **`updated_at` columns** get a trigger if you add them — use the project's standard `set_updated_at()` trigger function (create it in the migration if it doesn't exist yet).
10. **No data migrations in schema migrations.** Schema-only here. Data backfills are a separate migration with a clear `BEGIN; ... COMMIT;`.

## Workflow

1. **Read [docs/DESIGN.md §Data model](../../docs/DESIGN.md#1-data-model-postgres--postgis)** to understand the existing schema.
2. **Find the next migration number** by listing `packages/db/migrations/` and incrementing.
3. **Write the SQL.** Plain idempotent statements when possible (`IF NOT EXISTS` for indexes, `CREATE EXTENSION IF NOT EXISTS`). The deploy framework runs each migration once, but local re-runs during dev are common.
4. **Regenerate Kysely types**: `pnpm --filter @gctp/db generate-types`. Commit the generated file alongside the migration.
5. **Add an integration test** in `apps/api/test/integration/` exercising the new column/index path against Testcontainers PostGIS — at minimum a smoke test that the migration applies and a query works.

## Output

Return: the new migration file path, the SQL contents, the Kysely-types diff, and the test added. Do not commit; the user reviews and commits.

## Reference

- [docs/DESIGN.md](../../docs/DESIGN.md)
- [docs/ARCHITECTURE.md §Backend modules](../../docs/ARCHITECTURE.md#3-backend-modules-nestjs)
- Existing migrations under `packages/db/migrations/`
