# Testing

Three layers. Each catches what the others miss; don't substitute.

## Unit tests — pure functions

For pure logic with no I/O: the GPX parser, TSP, clustering, score functions, marginal-trim, planner sub-routines, zod-derived helpers.

- Co-located: `foo.ts` → `foo.spec.ts` in the same directory.
- Framework: vitest in `packages/shared`, jest in the apps (matches what each runner ships with).
- Run: `pnpm test` (all packages) or `pnpm --filter @gctp/api test`.

Tests for pure code must not import anything that touches the network, the filesystem (beyond fixtures), or a clock — use injectable deps.

## Integration tests — real PostGIS via Testcontainers

For anything that touches SQL, PostGIS spatial fragments, or the routing/route_legs cache.

- Location: `apps/api/test/integration/`.
- Setup: a PostGIS Testcontainer spun up per test file; migrations run on boot.
- **Never mock the database.** Mocked DB tests passed at a previous project while the prod migration was broken — the no-mock rule is a hard rule (see CLAUDE.md). The same applies to the OSRM and Overpass clients in integration scope: use a fake HTTP server with canned responses if you need determinism, but the SQL must hit a real Postgres.

## E2E tests — Playwright

For the actual user flow: GPX upload → filter → plan → save.

- Location: `apps/web/e2e/`.
- Stack: a real `docker compose up` (Postgres, Valkey, OSRM, api, web, jobs).
- Run locally: `pnpm test:e2e`. CI runs them on every PR that touches the API ↔ web boundary.
- Slow: ~minutes. Don't write E2E tests for things a unit or integration test could cover instead.

## Coverage expectations

- Pure functions: high (90 %+). They're cheap; cover the edge cases.
- Repositories / services: cover happy path + each branch that produces a different SQL shape. No need to chase 100 %.
- UI: cover the user-visible behaviour, not internal component state.

## When tests are flaky

Don't `.skip()` a flake without an `xfail` reason in code AND a tracking issue. Flaky tests degrade trust in the whole suite faster than missing tests do.
