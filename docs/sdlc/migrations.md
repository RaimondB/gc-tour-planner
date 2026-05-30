# Migrations

Plain SQL via [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate), stored in `packages/db/migrations/`.

## Rules

- **One change per file.** Adding a column AND its index AND a backfill = one migration. Adding a column for feature A and another for feature B = two migrations.
- **Never edit a merged migration.** Once a migration ran in prod (or even in another contributor's local DB), it is immutable. Need to change its effect? Write a new migration that fixes it.
- **Indexes live with the column they support.** Don't merge "add column" in one migration and "add index" in the next — the gap is a perf-regression window.
- **GPL header** on every `.sql` file:
  ```
  -- Copyright (C) 2026 Raimond Brookman and contributors
  -- SPDX-License-Identifier: GPL-3.0-or-later
  ```
- **Naming:** `<unix-ms-timestamp>_<short-kebab-slug>.sql`. The timestamp gives a stable lexical order across branches; the slug describes the change.

## How to add one

1. Create the file under `packages/db/migrations/` (the `db-migration-author` subagent does this end-to-end).
2. Write `-- Up` and `-- Down` sections. Down is best-effort but should at least drop what Up created so a local rollback works.
3. Run `pnpm --filter @gctp/db migrate up` against your dev DB to verify.
4. Regenerate Kysely types: `pnpm --filter @gctp/db generate` (or whatever the script name is — check `packages/db/package.json`).
5. Update [packages/db/src/schema.ts](../../packages/db/src/schema.ts) if a hand-written type lives there.
6. Document the affected query in the matching [design](../design/index.md) doc — e.g. spatial indexes for a new geometry column go in [design/data-model.md](../design/data-model.md) "Spatial helpers".

## How migrations get applied

- **Dev (`pnpm dev`):** [scripts/dev.sh](../../scripts/dev.sh) calls `pnpm --filter @gctp/db migrate:up` after Postgres becomes healthy, before launching api/web on the host.
- **UAT (`cd infra && docker compose up --build -d`):** the one-shot `migrate` compose service ([Dockerfile.migrate](../../infra/Dockerfile.migrate)) bind-mounts `packages/db/migrations` and runs `node-pg-migrate up`, exiting 0. `api`, `jobs`, and `osm2pgsql-import` declare `depends_on: migrate: service_completed_successfully`, so they block until the schema is current. No manual migrate step on the host.
- **To force a re-run** (e.g. after editing a SQL file without bumping any image): `docker compose up -d --force-recreate migrate`.

## PostGIS specifics

- Geometry columns: prefer `GEOGRAPHY(Point, 4326)` over `GEOMETRY(...)` unless you specifically need planar math. Geography handles wraparound and gives meters from `ST_DWithin` / `ST_DistanceSphere` for free.
- Indexes: `USING GIST (col)` for any geometry/geography you query spatially.
- Document the supporting index inline in the migration as a comment so a future schema-shrink doesn't drop it accidentally.

## Common gotchas

- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction — node-pg-migrate wraps your migration in one by default. Disable with `pgm.noTransaction()` at the top of the migration when you need it.
- `DROP TYPE … CASCADE` on an enum will cascade through every column that uses it. Almost never what you want — drop the column first.
- Big backfills should be batched (`UPDATE … LIMIT 10000` in a loop) or done in a separate migration with `noTransaction` + explicit `COMMIT`s.
