# CLAUDE.md — agent instructions for gc-tour-planner

This file is loaded into Claude Code's context for every session in this repo. Keep it concise, action-oriented, and current.

## Project orientation

- **What:** Web app to plan closed-loop geocaching tours from filtered cache clusters, with parking-spot awareness.
- **Stack (locked):** pnpm + Turborepo monorepo. TypeScript end-to-end. NestJS, React+Vite (MapLibre), Postgres+PostGIS, Kysely, zod, BullMQ+**Valkey** (not Redis), self-hosted OSRM.
- **License:** GPL-3.0-or-later. Every runtime dep must be GPLv3-compatible. See [docs/LICENSING.md](docs/LICENSING.md).

## Always read first

When picking up a session in this repo, read in this order:

1. [docs/requirements/](docs/requirements/index.md) — _what_.
2. [docs/architecture/](docs/architecture/index.md) — _how systems fit_.
3. [docs/design/](docs/design/index.md) — concrete schemas, APIs, algorithms.
4. [docs/sdlc/](docs/sdlc/index.md) — how we develop, test, ship, document.
5. [docs/adr/](docs/adr/) — _why_ for non-obvious choices.

The roadmap lives in [docs/requirements/roadmap.md](docs/requirements/roadmap.md). Don't skip ahead: M1 → M2 → M3 …

## Hard rules

These reflect deliberate decisions. Do not "improve" without an ADR.

- **Use Valkey, not Redis.** Redis 7.4+ is SSPL/RSAL — incompatible with our license. ([ADR-0004](docs/adr/0004-valkey-over-redis.md))
- **Never bundle Groundspeak attribute icons.** They are copyrighted. Use Material Symbols (Apache-2.0) or text chips.
- **OSM attribution** ("© OpenStreetMap contributors") is required on every map view, plus an `/attribution` page listing all OSM-derived components.
- **Per-user GPX isolation.** Caches uploaded from a user's GPX have `owner_id` set and are visible only to that user. Public-source rows (OKAPI later) have `owner_id = NULL`. Enforce in repositories — never skip this check.
- **No third-party API creds in the DB.** Auth holds project identity only. The GC.com partner key (M8) lives in env, injected into a single adapter.
- **Layering:** controller → service → repository → Kysely. Controllers never touch SQL.
- **No source code outside `apps/`, `packages/`, `infra/`.** Don't drop helpers at the repo root.
- **Docs stay in sync with code.** Any PR that adds or changes a functional requirement, an external API surface, an env knob, or a user-visible behaviour MUST update the matching file under [docs/requirements/](docs/requirements/index.md), [docs/design/](docs/design/index.md), or [docs/architecture/](docs/architecture/index.md) in the same PR. The [PR template](.github/PULL_REQUEST_TEMPLATE.md) checklist enforces it; skipping requires an explicit "no docs change needed" justification. Full policy: [docs/sdlc/docs-policy.md](docs/sdlc/docs-policy.md).

## Coding conventions

- **Filenames:** `kebab-case.ts`. Tests co-located as `*.spec.ts` / `*.test.ts`.
- **React components:** `PascalCase`. Functional with hooks. No class components.
- **Nest classes:** `PascalCase`, decorator-driven, DI via constructor.
- **Zod schemas:** single source of truth in `packages/shared`. Never duplicate a wire-DTO shape between client and server.
- **PostGIS:** in Kysely, use `sql\`ST_DWithin(...)\`` fragments. Document the index that supports each spatial query in the migration.
- **Migrations:** plain SQL via `node-pg-migrate`. One change per file. Never edit a merged migration.
- **Tests:**
  - Unit tests for pure functions (GPX parser, TSP, clustering, filter SQL builder).
  - Integration tests with real PostGIS via **Testcontainers** — do **not** mock the DB. Mocked DBs gave us bad migrations in past projects.
  - E2E via Playwright against the full docker-compose stack.
- **Comments:** only when the _why_ is non-obvious. Don't restate code in prose.
- **GPLv3 header** on every TS/JS/SQL source file:
  ```
  // Copyright (C) 2026 Raimond Brookman and contributors
  // SPDX-License-Identifier: GPL-3.0-or-later
  ```

## Development workflow

- **Bootstrap:** `pnpm install` from repo root.
- **Dev (default):** `pnpm dev` — brings up dev infra in a separate compose project (`gctp-dev`, via [infra/docker-compose.dev.yml](infra/docker-compose.dev.yml)) with shifted host ports: postgres 15432, valkey 16379. **OSRM and Overpass are shared with UAT** (read-only via host:5000 and host:5001) — running a second of either OOMs the host (OSRM peaks ~6 GiB; Overpass holds ~3 GiB + 30-min re-import per [ADR-0008](docs/adr/0008-self-host-overpass.md)). Runs migrations, launches api on :3030 and web on :5173 with hot reload + interleaved logs. **Never uses port 3000** (another service on the host owns it). Per-machine overrides go in `scripts/dev.env` (gitignored; see `scripts/dev.env.example`). `pnpm dev:down` stops dev infra (volumes preserved).
- **Full UAT-shape stack:** `cd infra && cp .env.example .env && docker compose up --build` — everything in compose (api/web/jobs/solver/overpass) under the `gctp` compose project on standard ports. First boot preprocesses OSRM (~10 min) and imports the Overpass NL extract (~30 min, runs in parallel); subsequent boots are fast. Use when validating prod-shape behaviour. **Does not share volumes with the dev stack.**
- **Per-package scripts:** `pnpm --filter @gctp/api dev`, `pnpm --filter @gctp/web dev`, etc.
- **Lint / typecheck / test:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.
- **License check:** `pnpm licenses:check` (also runs in CI).
- **DB migrations:** `pnpm --filter @gctp/db migrate up`. Generate Kysely types after schema changes.

## Subagents available

See [.claude/agents/](.claude/agents/) for repo-local subagent definitions:

- **`db-migration-author`** — writes node-pg-migrate SQL with matching PostGIS indexes and updates Kysely types.
- **`nest-module-scaffolder`** — scaffolds a new NestJS module (module/controller/service/repository/spec) following our layering rules.
- **`solver-adapter-implementer`** — drops in a `SolverTourPlanner` against the `TourPlannerStrategy` interface (for when M5+ needs it).

## When in doubt

- **Architectural change?** Write an ADR (`docs/adr/NNNN-...md`) before code.
- **Dependency choice?** Check license against [LICENSING.md §Hard compatibility rules](docs/LICENSING.md#2-hard-compatibility-rules).
- **Mid-milestone scope creep?** Push back. Finish current milestone (or open a ticket) before starting the next.

## Things this project intentionally does _not_ have

- Microservices. It is a modular monolith + workers.
- GraphQL. REST + OpenAPI generates the client.
- A DDD "domain" layer. Services own use-cases directly.
- Global frontend state stores. TanStack Query + URL params are enough.
- In-memory caching. Everything in Postgres or Valkey.

## See also

- [docs/requirements/](docs/requirements/index.md)
- [docs/architecture/](docs/architecture/index.md)
- [docs/design/](docs/design/index.md)
- [docs/sdlc/](docs/sdlc/index.md) — branching, testing, migrations, deploy, docs policy
- [docs/PLANNER_TUNING.md](docs/PLANNER_TUNING.md) — every `PLANNER_*` env knob + symptom→knob guide
- [docs/LICENSING.md](docs/LICENSING.md)
- [docs/adr/](docs/adr/)
