# ADR-0001 — Tech stack

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** Raimond Brookman (owner)

## Context

gc-tour-planner is a small-team / solo project that needs to:

1. Run spatial queries efficiently (radius search over thousands of caches; landuse polygon intersections).
2. Call external HTTP services (Overpass, OSRM) with caching and dedup.
3. Serve an interactive map UI with filters and live updates.
4. Keep one shared type definition for every DTO crossing the wire.
5. Support pluggable tour-planning strategies — start with a pure-TS heuristic, allow a Java solver later.
6. Be reproducible in dev and prod with a single `docker compose up`.
7. Stay GPLv3-compatible across all runtime dependencies.

The owner is comfortable with TypeScript end-to-end, Docker, and GitHub Actions. He explicitly asked for "the recommended bundle" rather than picking each tool — so this ADR records what was approved, with reasoning.

## Decision

Adopt the following stack, locked in for MVP:

| Concern            | Choice                                                                       | Why                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo               | **pnpm workspaces + Turborepo**                                              | Workspace dependency hoisting (`packages/shared` used by both `apps/api` and `apps/web` with zero glue), Turborepo for cached builds + parallel `dev` orchestration.                               |
| Language           | **TypeScript** (apps + packages)                                             | One mental model for client + server; zod schemas reused across the wire.                                                                                                                          |
| Backend framework  | **NestJS**                                                                   | Modules + DI map naturally to our planned module boundaries; OpenAPI is decorator-driven (auto-gen typed client); guards/interceptors give a clean auth layer.                                     |
| Frontend framework | **React + Vite**                                                             | Mainstream; Vite gives fast HMR; React ecosystem covers our needs (TanStack Query, MapLibre wrappers).                                                                                             |
| Map                | **MapLibre GL JS**                                                           | BSD-3 (GPLv3-compatible); vector tiles; first-class TS types; not tied to a proprietary provider.                                                                                                  |
| DB                 | **Postgres 16 + PostGIS 3**                                                  | The only realistic spatial DB option that's GPLv3-compatible, mature, and runs in Docker.                                                                                                          |
| DB access          | **Kysely + node-pg-migrate**                                                 | Kysely gives type-safe queries without the impedance of an ORM (Prisma's `Unsupported` type for PostGIS is a non-starter); `node-pg-migrate` keeps migrations as plain SQL we can read and review. |
| Validation         | **zod**                                                                      | Single source of truth for runtime + compile-time DTO shape; shared between client and server.                                                                                                     |
| Jobs               | **BullMQ + Valkey**                                                          | BullMQ is mature; Valkey (BSD-3) replaces Redis for license reasons — see [ADR-0004](0004-valkey-over-redis.md).                                                                                   |
| Routing engine     | **Self-hosted OSRM**                                                         | BSD-2; foot profile is exactly what we need; container image preprocesses an OSM extract once.                                                                                                     |
| OSM context        | **Overpass API**                                                             | The de-facto OSM query endpoint; cache aggressively in Postgres + Valkey so we stay well within fair-use limits on the public endpoint.                                                            |
| Tests              | **Jest (API) + Vitest (web) + Playwright (E2E) + Testcontainers (Postgres)** | Conventional, well-maintained; Testcontainers means our integration tests hit real PostGIS, not a mock.                                                                                            |
| Lint/format        | **ESLint + Prettier** in `packages/config`                                   | Shared presets across the monorepo.                                                                                                                                                                |
| Container          | **Docker Compose**                                                           | Single dev + prod orchestration; multi-stage Dockerfiles per app.                                                                                                                                  |
| CI                 | **GitHub Actions**                                                           | Free for public repos; first-class with GitHub.                                                                                                                                                    |

## Alternatives considered

- **Express + Fastify instead of NestJS.** Lighter, but we'd reinvent module boundaries, DI, decorator-driven OpenAPI, and guards. NestJS is overhead worth paying for a multi-module backend.
- **Drizzle / Prisma instead of Kysely.** Drizzle was close; Kysely won on its raw-SQL-fragment escape hatch (we need PostGIS functions like `ST_DWithin`, `ST_Contains`, `ST_MakePoint::geography` that don't fit an ORM model). Prisma's PostGIS support is poor.
- **Mapbox GL JS instead of MapLibre.** Mapbox went non-open in v2; MapLibre is the open fork and the only license-clean option.
- **Redis instead of Valkey.** Rejected for license reasons — see [ADR-0004](0004-valkey-over-redis.md).
- **Nx instead of Turborepo.** Both work; Turborepo is simpler and aligns with pnpm idioms we already use.
- **Bun / Deno.** Neither is mainstream enough for the libraries we depend on (NestJS, BullMQ); Node 20 LTS is the safe pick.

## Consequences

- **Single language end-to-end** — zod schemas shared, type errors caught at the wire.
- **Heavier Docker stack** in dev (six containers: postgres, valkey, osrm, api, web, jobs). Mitigated by docker-compose; first boot is slow (OSRM preprocessing); subsequent boots are fast.
- **OSRM extract is a one-time setup cost** per region change. `infra/osrm/bootstrap.sh` automates it.
- **Kysely is more verbose than an ORM** for trivial CRUD. Worth it for spatial flexibility.
- **NestJS opinions** (decorators, modules) lock us in somewhat. Migration cost is real if we ever change. Acceptable.
