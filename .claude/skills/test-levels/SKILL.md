---
name: test-levels
description: Decision guide for testing gc-tour-planner at the right level (unit / integration / e2e), and the rule that every bug fix ships a regression test. Use when writing or choosing tests, or when fixing a bug and deciding how to lock it.
---

# Testing levels for gc-tour-planner

Pick the **lowest** level that faithfully exercises the code. Lower = faster,
more deterministic, more precise about the cause. Don't climb a level for
"realism" a lower one already gives you. Authoritative policy:
[docs/sdlc/testing.md](../../../docs/sdlc/testing.md).

## Decision tree

1. **Is the logic pure** (no DB, network, clock, filesystem)? → **Unit test.**
   - GPX parsing, TSP, clustering, scoring, marginal-trim, filter/SQL *builders*,
     zod-derived helpers, geometry/formula helpers (e.g. `cluster-growth`).
   - vitest in `packages/shared` and `apps/web`; co-locate as `*.spec.ts` /
     `*.test.ts` next to the source.
   - If the buggy logic is buried in a big component/service, **extract it** to a
     pure function and test that. Extraction is part of the fix.

2. **Does it touch SQL / PostGIS / the routing cache?** → **Integration test.**
   - `apps/api/test/integration/`, real PostGIS via Testcontainers, migrations
     run on boot. **Never mock the DB** (hard rule — CLAUDE.md). Use fakes only
     for the queue / compute pool / OSRM (`FakeOsrmClient`).
   - Run: `pnpm --filter @gctp/api test:integration` (needs Docker). CI runs it
     on merge to `main`, not every PR — run it before cutting a UAT version.

3. **Is it a real user flow across the API↔web boundary** (upload → filter →
   discover → plan → save), or a MapLibre/runtime regression typecheck can't
   see? → **E2E (Playwright).**
   - `apps/web/e2e/`, against `docker compose up`. Run: `pnpm test:e2e`.
   - Slow + flaky-prone. Last resort. To read map/React internals, build with
     `VITE_E2E=1` and use `window.__gctp` (see below) — don't add ad-hoc hooks.

## Every bug fix ships a regression test

Non-negotiable: a test that **fails before the fix, passes after**, at the
lowest level that reproduces the bug (see tree above). Writing it is how you
prove you found the real cause.

- **Two code paths drifted apart** (client vs server, two callers of one rule)?
  Single-source the rule, then test the shared unit — kills the class, not just
  the instance. *Example:* the boundary-halo render bug was the web map fetch
  radius disagreeing with the API discovery-pool radius; the fix put the formula
  in `Tours.clusterPoolRadiusMeters` and the regression tests pin that one
  function (`packages/shared/.../cluster-growth.spec.ts`) plus the web
  cache-union helper — no e2e needed.
- Resist "it's too small to test." Small bugs recur the most.

## E2E test helpers — `VITE_E2E`

Playwright can't see WebGL markers or React state. The app exposes ONE
env-gated surface: `apps/web/src/lib/test-helpers.ts`. In a **dev-mode** build
with `VITE_E2E` set, helpers live under `window.__gctp` (e.g. `window.__gctp.map`
→ the live MapLibre map, for `getSource(id).serialize().data.features`
assertions). Run e2e against a dev server: `VITE_E2E=1 pnpm --filter @gctp/web
dev`. Extend that module (don't sprinkle `window.__x`), and document each handle.

**Production-safe by construction.** The gate is `import.meta.env.DEV &&
VITE_E2E` (both compile-time literals), so every `vite build` folds it to
`false` and esbuild strips the helper from the bundle — even if `VITE_E2E=1`
leaks into a prod build. Verify with `grep __gctp apps/web/dist/**/*.js` (empty).

## Checklist before opening the PR

- [ ] New/changed pure logic has unit tests covering edge cases (target 90 %+).
- [ ] New SQL/spatial shape has an integration test against real PostGIS.
- [ ] Bug fix? A regression test that fails on the pre-fix code is included.
- [ ] No DB mocks. No `.skip()` without an `xfail` reason + tracking issue.
- [ ] Docs synced if behaviour/requirement/env-knob changed (docs-policy).
