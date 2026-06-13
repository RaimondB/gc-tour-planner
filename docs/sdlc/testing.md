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
- Setup: a PostGIS Testcontainer spun up per test file; migrations run on boot. Shared service wiring (real collaborators against the container DB + faithful fakes for the queue / compute pool / OSRM) lives in `integration-helpers.ts`.
- Run: `pnpm --filter @gctp/api test:integration` (needs Docker).
- **CI:** runs in the `integration` job — on merges to `main` (the pre-UAT point) and on manual `workflow_dispatch`, **not** on every PR (it's Docker-bound and slower). It is intentionally **not** a branch-protection required check; a red run means "don't promote to UAT yet". So it can drift if only unit CI is watched — run it before cutting a UAT version.
- **Never mock the database.** Mocked DB tests passed at a previous project while the prod migration was broken — the no-mock rule is a hard rule (see CLAUDE.md). The same applies to the OSRM and Overpass clients in integration scope: use a fake (e.g. the in-process `FakeOsrmClient`) if you need determinism, but the SQL must hit a real Postgres.

## E2E tests — Playwright

For the actual user flow: GPX upload → filter → plan → save.

- Location: `apps/web/e2e/`.
- Stack: a real `docker compose up` (Postgres, Valkey, OSRM, api, web, jobs).
- Run locally: `pnpm test:e2e`. CI runs them on every PR that touches the API ↔ web boundary.
- Slow: ~minutes. Don't write E2E tests for things a unit or integration test could cover instead.

## Regression tests for bug fixes

**Every bug fix ships with a test that fails before the fix and passes after.**
No exceptions for "obvious" one-liners — the test is what stops the bug from
silently coming back, and writing it is how you prove you understood the cause.

- **Reproduce at the lowest level that captures the bug.** A logic bug → a unit
  test on the (often newly-extracted) pure function. A SQL/spatial bug → an
  integration test against PostGIS. A user-flow bug → an e2e. Don't reach for an
  e2e when a unit test reproduces it: e2e is slow and flaky, and a unit test
  pins the cause more precisely. (Worked example: the boundary-halo render bug —
  ADR-0026 — was a radius-formula mismatch between the API pool and the web map
  fetch. The durable fix single-sourced the formula in
  `Tours.clusterPoolRadiusMeters`, and the regression test is two unit specs
  pinning that formula + the cache-union helper — not an e2e that would have
  needed grow-on, boundary-straddling fixture data.)
- **When a bug came from two code paths drifting apart** (client vs. server, or
  two callers of one rule), single-source the rule and test the shared unit —
  that kills the whole class, not just this instance.
- **If the only faithful reproduction is an e2e**, say so in the PR and write it;
  but first try to extract the buggy logic into something unit-testable.
- Pick the level deliberately — the **`test-levels`** skill (`.claude/skills/`)
  is the decision tree.

## E2E test helpers (`VITE_E2E`)

Playwright drives the real UI but can't read React/MapLibre internals (the map
paints to a WebGL canvas — there are no DOM markers to count). Instead of
scattering ad-hoc `window.__x` hooks, the web app exposes one explicit,
env-gated surface: `apps/web/src/lib/test-helpers.ts`. In a **dev-mode** build
that sets `VITE_E2E`, helpers appear under `window.__gctp` (e.g.
`window.__gctp.map`). Add new handles there as e2e needs them — keep the surface
small and documented.

Run e2e against a dev-mode, helper-enabled server:
`VITE_E2E=1 pnpm --filter @gctp/web dev` (Playwright's default baseURL is
:5173). The helpers exist **only** in dev mode by design — see the production
guarantees below.

**Production safety (two compile-time guarantees).** The gate is
`import.meta.env.DEV && VITE_E2E`, both inlined at build time:

1. *Not shipped.* Any `vite build` runs in production mode (`DEV === false`), so
   the gate folds to the literal `false` and esbuild dead-code-eliminates the
   whole helper body **and** the `window.__gctp` assignment. A prod `dist/`
   contains no executable reference to it (verified: `grep __gctp dist/**/*.js`
   → nothing; only the inert `.js.map` source map mentions the identifier).
2. *Can't be re-enabled.* Even if `VITE_E2E=1` leaks into a production build, the
   `DEV` conjunct is still `false`, so the helper stays stripped. There is no
   runtime switch to flip — `import.meta.env` is compile-time only. The
   deployment image (`infra/Dockerfile.web`) also never declares `VITE_E2E` as a
   build arg, so it can't reach the build in the first place.

## Coverage expectations

- Pure functions: high (90 %+). They're cheap; cover the edge cases.
- Repositories / services: cover happy path + each branch that produces a different SQL shape. No need to chase 100 %.
- UI: cover the user-visible behaviour, not internal component state.

## When tests are flaky

Don't `.skip()` a flake without an `xfail` reason in code AND a tracking issue. Flaky tests degrade trust in the whole suite faster than missing tests do.
