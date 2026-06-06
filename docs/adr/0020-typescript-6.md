# ADR-0020 — Migrate to TypeScript 6.0

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0016](0016-staged-dependency-upgrades.md) (the staged strategy this is cluster 6 of), [ADR-0017](0017-nestjs-11-express-5-migration.md), [ADR-0018](0018-zod-4-shared-wire-contract.md), [ADR-0019](0019-frontend-majors-react-vite-maplibre.md) (cluster 5), [ADR-0001](0001-stack-choices.md)

## Context

Cluster 6 — the **last** — of the staged dependency upgrade
([ADR-0016](0016-staged-dependency-upgrades.md)). Clusters 1–5 are merged and
UAT-deployed; `main` is green. After this the repo is fully current; the next
horizon is TypeScript 7 (the native Go compiler, "tsgo"), whenever it stabilises.

We are on `typescript` 5.6.3, pinned identically in **five** `package.json` files
(root + `apps/web`, `apps/api`, `packages/db`, `packages/shared`). Latest stable is
**6.0.3** (the line went 5.6 → 5.7 → 5.8 → 5.9 → 6.0). This clears **no security
advisory** — it is a currency move — and it is the **lowest-runtime-risk cluster of
the six**, for a structural reason: TypeScript is a **compile-time typechecker and
emitter, not a shipped runtime dependency**.

### Why the runtime blast radius is near-zero

- **The web bundle does not depend on the tsc version.** Since cluster 5, Vite 8
  transforms TS via **oxc** ([ADR-0019](0019-frontend-majors-react-vite-maplibre.md)),
  so the browser bundle is produced without `tsc` at all. There is no maplibre/React
  runtime surface to regress here — **e2e is not the gate for this cluster** (unlike
  cluster 5).
- The only emitted artifacts that change are the **`tsc`-built JS for
  `apps/api` / jobs, `packages/shared`, and `packages/db`**. A tsc-major can shift
  emit subtly, so the api's integration tests matter; but there is no behavioural API
  or wire change intended.
- So the real risk is purely **new type errors** surfaced by TS 6.0's stricter and
  cumulative `lib.d.ts` tightening (5.7 → 5.8 → 5.9 → 6.0 all arrive at once),
  caught by `pnpm typecheck`.

### Audit (2026-06-06) — the coupling is loose and the configs are clean

- **`typescript-eslint` needs no bump.** It is already on 8.60.1 (the latest) and
  already supports TS 6: peer `typescript >=4.8.4 <6.1.0` covers 6.0.x. So lint is
  unaffected and this cluster is **typescript-only**.
- **`tsc-watch` needs no bump.** `apps/api` dev uses 6.2.1, which peers
  `typescript: *`. (Latest is 7.2.0 — an unrelated optional tooling choice, out of
  scope unless it misbehaves.)
- **`engines.node` already satisfies TS 6.0.** TS 6.0.3 requires only `node >=14.17`;
  cluster 5 set the repo range to `^20.19.0 || >=22.12.0`.
- **No removed/deprecated compiler options in our tsconfigs.** TS 6.0 turns several
  long-deprecated options into errors; a scan of every `tsconfig*.json` found none of
  them (`importsNotUsedAsValues`, `preserveValueImports`, `keyofStringsOnly`,
  `outFile`, ES3 `target`, the `suppress*` family). The base config is all-modern
  (target ES2022, `moduleResolution` Bundler; node config uses NodeNext) and already
  strict (`noUncheckedIndexedAccess`, `noImplicitOverride`, `useUnknownInCatchVariables`)
  with `skipLibCheck:true`. So the "removed flags become errors" part of TS 6.0 should
  not bite the configs — the residual risk is _code_ type errors, and the existing
  discipline suggests modest fallout rather than a wall.

## Decision

**Bump `typescript` 5.6.3 → 6.0.x (currently 6.0.3) across all five `package.json`
pins, as a single cluster PR on its own branch (`chore/deps-typescript`), green
before merge.** Keep `typescript-eslint` (8.60.1) and `tsc-watch` (6.2.1) where they
are — this cluster is typescript-only. `pnpm typecheck` is the gate; fix whatever new
type errors TS 6.0 surfaces.

### Staging

Try **straight 5.6.3 → 6.0.3** first. If `typecheck` throws a lot, step
`5.7 → 5.8 → 5.9 → 6.0` to localise which release introduced each error — cheap here
because the work is **typecheck-only, zero runtime**, so no per-step build or e2e is
needed, just `pnpm typecheck`. Keep the five pins in lockstep at every step; a
split TS version across the workspace is its own source of confusing errors.

### As shipped

Landed on `chore/deps-typescript` (PR #25, squash `27fa481`) as a **single
two-file delta**: the five `typescript` pins 5.6.3 → 6.0.3 plus the lockfile.
**Straight 5.6.3 → 6.0.3 worked first try** — no `5.7 → 5.8 → 5.9 → 6.0` stepping
was needed.

- **Zero code changes.** The audit held in full: TS 6.0's cumulative `lib.d.ts`
  tightening surfaced **no new type errors** across the four typechecked packages —
  the already-strict config (`noUncheckedIndexedAccess`, `noImplicitOverride`,
  `useUnknownInCatchVariables`) plus `skipLibCheck` left nothing for 6.0 to catch.
  `apps/api`, the largest surface, was clean.
- **No peer cascade.** `typescript-eslint` (8.60.1) and `tsc-watch` (6.2.1) needed no
  bump — lint and api dev are unaffected. The cluster stayed strictly typescript-only.
- **Gates green:** `pnpm typecheck` (0 errors), `pnpm lint` (2 pre-existing
  `exhaustive-deps` warnings, 0 errors), `pnpm test` (96 unit), the Testcontainers
  integration suite (42 — the relevant gate for the re-emitted api JS), the vite-8 web
  build, and `licenses:check` (TypeScript is Apache-2.0; the lone `UNLICENSED:1` is the
  root pkg). e2e was not run as a gate, as decided above — the web bundle is
  tsc-version-independent under oxc.
- **UAT redeployed** from `main` (`docker compose -p gctp up --build -d`): migrate
  exited 0, api booted clean on TS-6-emitted JS, and the edge smoke over the compose
  network returned **200** for `/`, `/api/health`, and `/api/admin/queues`. The web
  runtime was unchanged, as predicted.

This closes **cluster 6 — the last** — of [ADR-0016](0016-staged-dependency-upgrades.md);
the repo is now fully current. The next toolchain horizon is TypeScript 7 (the native
"tsgo" compiler), to be evaluated when it stabilises.

## Breaking changes / blast radius

- **Type errors from stricter `lib.d.ts`** across the four typechecked packages
  (`apps/api` is the largest surface). Unknown count until run; expected modest given
  the already-strict config + `skipLibCheck`.
- **`tsc` emit drift** for `apps/api` / jobs / `packages/shared` / `packages/db`. No
  behavioural change intended — covered by the api Testcontainers integration suite.
- **`apps/web` typecheck** (`tsc --noEmit`) can surface React 19 / maplibre 5 type
  interactions under the newer lib, but the **web build/runtime is unaffected** (oxc).

## Validation (gating)

TypeScript is compile-time, so the gate is typecheck + the suites that exercise the
re-emitted JS — **not** the map e2e:

- **`pnpm typecheck` across the monorepo** — the primary signal; this is where TS 6.0
  fallout lands.
- `pnpm lint` (typescript-eslint 8.60.1 on TS 6.0) + `pnpm test`.
- **Testcontainers integration suite** (`pnpm --filter @gctp/api test:integration`,
  needs Docker) — the api's emitted JS changes, so this matters more than e2e here.
  Run the existing Playwright upload smoke as a sanity check, but it is not the gate.
- `pnpm --filter @gctp/web build` (vite-8 build; tsc-version-independent, run to be
  safe) + `pnpm licenses:check` (TypeScript is Apache-2.0 — GPLv3-compatible — but
  re-run per [ADR-0016](0016-staged-dependency-upgrades.md); the lone `UNLICENSED:1`
  is the root pkg).

## Consequences

- Gets the toolchain onto the supported major and closes the **last** gap in the
  upgrade programme ([ADR-0016](0016-staged-dependency-upgrades.md)); the repo is then
  fully current.
- A small, concentrated PR: five version pins plus whatever type fixes TS 6.0 demands,
  with no dependency-tree churn (no peer cascade).
- **Reversible by revert** (no migrations, no data changes); UAT redeploys from `main`
  after merge to ship the rebuilt api/jobs JS — the **web runtime is unchanged**, so
  the redeploy risk is limited to the backend emit.
- Establishes TS 6.0 as the floor and the staging point for an eventual TS 7 (native
  "tsgo") evaluation.

## Alternatives considered

- **Hold on 5.6.3.** Legitimate, and the plan always listed cluster 6 as "last, _or
  hold_." TS 6.0 is largely the deprecations-become-errors hardening release and the
  bridge to TS 7 (native); if no pain is felt on 5.6, waiting until TS 7 stabilises is
  defensible. **Rejected for now** because "stay current" is the project's stated goal
  and this is the only remaining gap — but it is a real option the owner signs off on
  per cluster, not a foregone conclusion.
- **Fold the `tsc-watch` 6→7 bump in.** Rejected: unrelated to TS 6.0 (6.2.1 already
  peers `typescript: *`); keep the cluster typescript-only. Revisit `tsc-watch`
  separately if it misbehaves on TS 6.
- **Jump straight to TS 7 (native) instead.** Rejected: not yet a stable drop-in for a
  full typecheck/emit pipeline at the time of writing; 6.0 is the supported major and
  the correct stepping stone.
- **Big-bang all six clusters.** Already rejected in
  [ADR-0016](0016-staged-dependency-upgrades.md); irrelevant now that this is the last
  remaining cluster.
