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
- **Auth contract (M6).** Sessions ride an httpOnly `SameSite=Lax` cookie + double-submit CSRF token; never tokens in localStorage. No auth tokens and no Google OAuth access/refresh tokens persisted in the DB. A global guard authenticates every route; the `@Public()` no-auth set is **normative** — adding to it requires updating the inventory in [docs/design/auth-and-sharing.md](docs/design/auth-and-sharing.md) and [persistence-sharing.md FR-P11](docs/requirements/persistence-sharing.md) in the same PR. The `dev@gctp.local` bypass stays behind `AUTH_DEV_BYPASS`, hard-refused under `NODE_ENV=production`. See [ADR-0021](docs/adr/0021-auth-and-session-strategy.md) / [ADR-0022](docs/adr/0022-tour-sharing-link-security.md).
- **Layering:** controller → service → repository → Kysely. Controllers never touch SQL.
- **No source code outside `apps/`, `packages/`, `infra/`.** Don't drop helpers at the repo root.
- **No specific local/host setup details in the repo.** This is a public repo. Never commit (in code, comments, docs, ADRs, configs, OR commit messages) anything that identifies the actual deployment: public hostnames/domains, LAN IPs or subnets, machine names/specs, tunnel/account IDs, names of other services co-located on the host, or shared infra (proxy networks, etc.). Write about the architecture **generically** — "the host", "a shared reverse proxy", "`<app-host>`", "another workload". Secrets/tokens live in gitignored env files. If real values are genuinely needed for operations, keep them **out of the repo** (a local note, password manager, or the deployment dashboard) — not in tracked files. When in doubt, generalize.
- **Docs stay in sync with code.** Any PR that adds or changes a functional requirement, an external API surface, an env knob, or a user-visible behaviour MUST update the matching file under [docs/requirements/](docs/requirements/index.md), [docs/design/](docs/design/index.md), or [docs/architecture/](docs/architecture/index.md) in the same PR. The [PR template](.github/PULL_REQUEST_TEMPLATE.md) checklist enforces it; skipping requires an explicit "no docs change needed" justification. Full policy: [docs/sdlc/docs-policy.md](docs/sdlc/docs-policy.md).
- **PWA / offline / caching — hard-won rules ([ADR-0029](docs/adr/0029-frontend-offline-resilience-caching-and-state.md), skill [`frontend-pwa-offline`](.claude/skills/frontend-pwa-offline/SKILL.md)).** Before touching the SW/workbox config, nginx cache headers, PWA icons, offline UI, MapLibre layers, or auth/session status: (1) the SW `navigateFallbackDenylist` must exclude every origin/edge-owned path (`/api/*`, `/cdn-cgi/*` — Cloudflare Access callback); (2) stable-named assets (icons, `sw.js`, manifest) are `no-cache`, never `immutable`, and **bump `?v=N` on the manifest icon `src`s on every icon byte change** (the installed WebAPK is keyed on the URL); (3) cross-route state that must survive navigation/reload lives in a provider **above the router** with explicit transitions and durable persistence (IndexedDB + a localStorage pointer), persisted on intent — not in scattered `useState` + mount effects or router history state; (4) **never derive auth status from connectivity** (an errored `/auth/me` keeps the last-known user; only a clean 401→null logs out); (5) guard every MapLibre op on the map `ready` flag. Offline is only testable in a production build (`devOptions.enabled:false`).
- **Marketing page parity.** When a shipped change alters what users can do, update the public landing page (`apps/web/src/features/landing/LandingPage.tsx`, route `/welcome`) in the same PR. It's user-visible surface and is on the PR docs checklist.

## Coding conventions

- **Filenames:** `kebab-case.ts`. Tests co-located as `*.spec.ts` / `*.test.ts`.
- **React components:** `PascalCase`. Functional with hooks. No class components.
- **Nest classes:** `PascalCase`, decorator-driven, DI via constructor.
- **Zod schemas:** single source of truth in `packages/shared`. Never duplicate a wire-DTO shape between client and server.
- **PostGIS:** in Kysely, use `sql\`ST_DWithin(...)\`` fragments. Document the index that supports each spatial query in the migration.
- **Migrations:** plain SQL via `node-pg-migrate`. One change per file. Never edit a merged migration.
- **tsconfig `extends`:** any package Vite or Vitest compiles (`apps/web`, `packages/shared`, `apps/api`) must use a **relative** `extends` (e.g. `../../packages/config/tsconfig.node.json`), **not** the `@gctp/config/*` specifier. Vite 8's oxc transform resolves a nested `extends` against the pnpm symlink dir and fails with `Tsconfig not found` — while plain `tsc` stays green (that's the tell). `packages/db` is the lone tsc-only package and keeps the specifier. The moment a package gains Vitest, convert its `extends` in the same PR.
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
- **Dev (default):** `pnpm dev` — brings up dev infra in a separate compose project (`gctp-dev`, via [infra/docker-compose.dev.yml](infra/docker-compose.dev.yml)) with shifted host ports: postgres 15432, valkey 16379. **OSRM is shared with UAT** (read-only via host:5000) — a second OSRM instance OOMs the host. **Landuse polygons + OSM parking facilities** live in the dev Postgres (populated once via the `osm2pgsql-import` one-shot service per [ADR-0009](docs/adr/0009-osm2pgsql-replaces-overpass.md) + [ADR-0011](docs/adr/0011-osm-parking-facilities.md) — single Lua, two tables, one PBF pass). No Overpass sidecar anymore. Runs migrations, launches api on :3030 and web on :5173 with hot reload + interleaved logs. **Never uses port 3000** (another service on the host owns it). Per-machine overrides go in `scripts/dev.env` (gitignored; see `scripts/dev.env.example`). `pnpm dev:down` stops dev infra (volumes preserved).
- **Full UAT-shape stack:** `cd infra && cp .env.example .env && docker compose up --build` — everything in compose (api/web/jobs/solver/osm2pgsql-import) under the `gctp` compose project on standard ports. First boot preprocesses OSRM (~10 min) and imports both `landuse_polygons` and `parking_facilities` into Postgres via the single osm2pgsql pass (~30-40 min, runs in parallel); subsequent boots short-circuit the import (~2 s). Use when validating prod-shape behaviour. **Does not share volumes with the dev stack.**
- **Per-package scripts:** `pnpm --filter @gctp/api dev`, `pnpm --filter @gctp/web dev`, etc.
- **Lint / typecheck / test:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.
- **License check:** `pnpm licenses:check` (also runs in CI).
- **Formatting & docs links:** `pnpm format:check` (Prettier) covers `ts/tsx/js/json/yaml` only — **Markdown is hand-authored and intentionally not Prettier-formatted** (`.prettierignore`). Internal doc links are gated by the **`docs-links`** CI job (lychee, offline): relative links + `#anchors` between Markdown files must resolve. It's advisory (won't block merge) but keep it green; run lychee locally if you touch many links.
- **Security audit:** `pnpm audit --prod` for shipped deps; when bumping **build/test tooling**, run the full `pnpm audit` too — a dev-only major can silently leave one package behind (e.g. `apps/api` lingered on Vitest 2 → a critical CVE while `--prod` stayed clean).
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
- GraphQL. REST + OpenAPI is the eventual client-gen path — but the web client is currently **hand-written** in `apps/web/src/lib/api.ts`; the generated client is deferred until the API surface stabilises.
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
