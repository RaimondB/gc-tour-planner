# ADR-0018 — Migrate to zod 4 (the shared wire contract)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0016](0016-staged-dependency-upgrades.md) (the staged strategy this is cluster 4 of), [ADR-0017](0017-nestjs-11-express-5-migration.md) (cluster 3 — set the `zod` ≥ 3.25 floor), [ADR-0001](0001-stack-choices.md)

## Context

Cluster 4 of the staged dependency upgrade ([ADR-0016](0016-staged-dependency-upgrades.md)).
We are on `zod` 3.25.76 across `@gctp/shared`, `@gctp/api`, and `@gctp/web` — the
floor that cluster 3 ([ADR-0017](0017-nestjs-11-express-5-migration.md)) established
precisely to de-risk this jump. `zod` 4 is the supported major (3.x is in
maintenance); it is also substantially faster to parse and ships a smaller type
footprint, which matters because **every wire DTO crosses this library**.

Unlike cluster 3, this cluster clears **no security advisory** — it is a currency +
correctness move. Its risk profile is different from the framework jump: zod is the
**single source of truth for the api ↔ web wire contract** ([CLAUDE.md](../../CLAUDE.md)
"Zod schemas: single source of truth in `packages/shared`"). All **521 zod call
sites live in `packages/shared`** (16 files); `apps/api` and `apps/web` declare no
schemas of their own — they import the compiled schemas and their inferred types.
So a zod-4 type-inference change surfaces as a TypeScript error in **both** apps at
once. That blast radius — not raw API churn — is why this is its own cluster and its
own PR.

### Why this is a smaller change than its reputation

An audit of the actual surface (2026-06-05) found the codebase already sits on the
zod-4-compatible side of most breaking changes:

- **`nestjs-zod` needs no bump.** 5.4.0 (landed in cluster 3) already peers
  `zod ^3.25.0 || ^4.0.0`. It stays at 5.4.0 — **this cluster is zod-only.**
- **`z.record` already uses the two-arg form** (`z.record(z.string(), z.number())`)
  that zod 4 requires — all 7 sites. No change.
- **No removed APIs in use:** grep finds zero `deepPartial`, `passthrough`, `strict`,
  `strip`, `merge`, `nonempty`, or `preprocess`. The one `.extend()` keeps its zod-4
  signature.
- **No `errorMap` / `nativeEnum` / `invalid_type_error` / `required_error` / `.errors`**
  access anywhere — the renamed/removed error-customization surface is untouched.
- The api validates request bodies with **manual `Schema.safeParse(body)`** in
  controllers (not `createZodDto`/`ZodValidationPipe`), and serializes failures with
  `parsed.error.flatten()` (13 sites). `.safeParse` return shape is unchanged; in
  zod 4 `.flatten()` is **deprecated but still works** with the same
  `{ formErrors, fieldErrors }` shape — so the **validation-error wire contract is
  stable**.

### What actually changes (deprecations, not breakage)

- **String-format methods → top-level functions.** `.email()` (4), `.url()` (3),
  `.datetime()` (2) are deprecated in zod 4 in favour of `z.email()`, `z.url()`,
  `z.iso.datetime()`. They still validate; modernizing is optional cleanup.
- **`ZodError.flatten()` → `z.flattenError(err)`** (and `.format()` → `z.treeifyError`).
  Deprecated, still works. Optional cleanup at the 13 controller sites.
- **`.default()` inference**: zod 4 makes the _input_ of a defaulted field optional
  (output stays required). Mostly transparent; watch for any place that destructured
  the input type of a schema with defaults.
- `z.coerce.date()` (1 site, landuse-profiles) is unchanged in zod 4.

## Decision

**Bump `zod` 3.25.76 → 4.x (latest, currently 4.4.3) in `@gctp/shared`, `@gctp/api`,
and `@gctp/web`, as a single cluster PR. `nestjs-zod` stays 5.4.0.** Treat the
deprecation cleanups (string-format methods, `flattenError`) as **optional, in-scope-if-cheap**
— the gate is a green monorepo, not a deprecation-warning count. Defer the frontend
majors (React 19 / maplibre 5 / Vite / Vitest) to cluster 5; they are unrelated churn.

### As shipped

The bump itself needed **zero** code changes — monorepo `typecheck`, lint, and all
unit tests passed on zod 4 untouched, confirming the audit's "few or no hard breaks".
The cheap deprecation cleanups applied (all in `packages/shared`, where direct `z.*`
use is already the norm): `z.string().datetime({ offset: true })` → `z.iso.datetime(…)`
(2 sites) and `z.string().uuid()` → `z.uuid()` (4 sites). The audit's `.email()`/`.url()`
counts were stale — neither method appears in the current source. The 13
`parsed.error.flatten()` controller sites were **left as-is**: they are wire-stable and
only type-level-deprecated, and modernizing them would have introduced a direct `zod`
import into 5 controllers that today reach zod only through `@gctp/shared` — not worth
trading that clean import surface for a cosmetic deprecation. They can move to
`z.flattenError()` whenever the api otherwise gains a direct zod dependency.

## Validation (gating)

zod's types flow to both apps and its runtime backs every request validation and the
web's response parsing, so the gate is the full local suite plus the Docker tiers:

- **`pnpm typecheck` across the whole monorepo** — the primary signal. Shared's
  inferred types are consumed by api + web; a zod-4 inference shift fails here first.
- `pnpm lint`, `pnpm test` — unit tests include the api controller `.safeParse` paths
  and the shared schema tests.
- **Testcontainers integration suite** (`pnpm --filter @gctp/api test:integration`,
  needs Docker) — exercises the real request → `safeParse` → service → DB path.
- **Playwright e2e** (the upload smoke from cluster 3 + any added) — the web does ~19
  runtime `.safeParse`/`.parse` of wire responses; e2e confirms they still parse.
- `pnpm licenses:check` — zod 4 is MIT, but re-confirm no transitive drift.

## Consequences

- Gets the wire-contract library onto the supported major; faster parsing, smaller
  types. Establishes zod 4 as the floor for any future schema work.
- A focused, reviewable PR: the diff is concentrated in `packages/shared` with
  type-only ripples into api/web — exactly the blast radius this staging was meant to
  isolate.
- **Reversible by revert** (no migrations, no data changes); UAT redeploys from `main`
  after merge, as with every cluster.
- Leaves cluster 5 (frontend majors) as the last risky tier.

## Alternatives considered

- **Fold zod 4 into cluster 3 (Nest 11).** Rejected there and still rejected: the wire
  contract's blast radius is orthogonal to the framework's and deserves an independent,
  bisectable PR. `nestjs-zod` 5 runs fine on zod 3.25, so cluster 3 never needed it.
- **Stay on zod 3.x.** Rejected: 3.x is maintenance-only; deferring just grows the gap
  before the frontend cluster, which will want a current schema lib underneath it.
- **Adopt the `zod/v4` subpath incrementally while keeping `zod/v3` for some schemas.**
  Rejected: a split-version wire contract is exactly the un-reviewable state this repo's
  single-source-of-truth rule exists to prevent. Move the whole `packages/shared` at once.
