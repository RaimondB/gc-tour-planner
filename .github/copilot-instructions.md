# GitHub Copilot instructions — gc-tour-planner

`CLAUDE.md` at the repo root is the canonical agent guidance — read it first. This file mirrors the essentials for Copilot Chat / Workspaces.

## Project

A web app to plan closed-loop geocaching tours. pnpm + Turborepo monorepo, TypeScript end-to-end. Backend: NestJS. Frontend: React + Vite + MapLibre. DB: Postgres 16 + PostGIS 3 via Kysely + node-pg-migrate. Jobs: BullMQ + **Valkey** (not Redis). Routing: self-hosted OSRM. License: **GPL-3.0-or-later**.

## Hard rules

1. **Valkey, not Redis** — Redis 7.4+ is SSPL/RSAL, incompatible with GPLv3.
2. **No Groundspeak attribute icons** — copyrighted. Use Material Symbols or text chips.
3. **OSM attribution on every map view.**
4. **Per-user GPX isolation.** `owner_id` scoping enforced in repositories.
5. **No third-party API creds in the DB.**
6. **Layering:** controller → service → repository → Kysely.
7. **Code lives under `apps/`, `packages/`, or `infra/`** — never the repo root.
8. **Migrations are append-only.** One change per file.
9. **Zod schemas live in `packages/shared`.** Never duplicate DTO shapes between client and server.
10. **GPLv3 header** on every TS/JS/SQL source file:
    ```
    // Copyright (C) 2026 Raimond Brookman and contributors
    // SPDX-License-Identifier: GPL-3.0-or-later
    ```
11. **Every runtime dep must be GPLv3-compatible.** CI fails on SSPL, RSAL, BUSL, Commons Clause, CC-BY-NC.

## Style

- Filenames `kebab-case.ts`. React `PascalCase`. Nest classes `PascalCase`.
- Tests co-located as `*.spec.ts` / `*.test.ts`. Integration tests use Testcontainers PostGIS, **not mocks**.
- Comments only when the _why_ is non-obvious.

## Read for context

- `CLAUDE.md`
- `docs/requirements/`, `docs/architecture/`, `docs/design/`, `docs/sdlc/`, `docs/LICENSING.md`
- `docs/adr/`
