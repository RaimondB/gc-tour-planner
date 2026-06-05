# ADR-0017 — Migrate to NestJS 11 + Express 5 (+ multer 2, bullmq/@bull-board)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0016](0016-staged-dependency-upgrades.md) (the staged strategy this is cluster 3 of), [ADR-0001](0001-stack-choices.md), [ADR-0014](0014-planner-compute-worker-pool.md)

## Context

We are on NestJS 10.4.22 / Express 4.21.2. Cluster 3 of the staged upgrade
([ADR-0016](0016-staged-dependency-upgrades.md)) is the NestJS 11 jump. It is the
**highest-security-value** cluster: it clears every runtime Dependabot advisory
still open after clusters 1–2.

Advisories cleared by this cluster (current `pnpm audit --prod`: 3 high, 4 moderate):

| Advisory                                                                          | Severity | Cleared by                                                           |
| --------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `multer` DoS ×3 (incomplete cleanup, resource exhaustion, uncontrolled recursion) | HIGH     | multer 2.1.1, pulled by `@nestjs/platform-express` 11                |
| `@nestjs/core` injection                                                          | MODERATE | `@nestjs/core` ≥ 11.1.18                                             |
| `file-type` DoS ×2 (ASF infinite loop, ZIP bomb)                                  | MODERATE | `@nestjs/common` 11 bundles `file-type@21.3.4` (≥21.3.2)             |
| `uuid` buffer-bounds (v3/v5/v6+buf)                                               | MODERATE | `bullmq` update drops the `uuid@9` path _(confirm during migration)_ |

These cannot be fixed without the major: `@nestjs/platform-express` 11 _is_ Express 5
and brings multer 2, and the `@nestjs/core` fix only exists in 11.1.18+.

### Why these packages move as one cluster

They are peer-coupled — none can move alone:

- `@nestjs/platform-express` 11 → **Express 5** (and **multer 2**).
- `@nestjs/swagger` 11 peer-requires `@nestjs/core` ^11; `@nestjs/config` 4, `@nestjs/bullmq` 11, `@nestjs/cli` 11 align to 11.
- **`@bull-board/express` 7** (and even 6.21+) peer-requires `express ^5.2.1` + `ejs ^5` — so the Bull dashboard can only move once we're on Express 5. `bullmq` 5.78 widens `JobProgress` to include `string`, which the pinned `@bull-board/api` 6.5 adapter rejects — so `bullmq` and `@bull-board` are in this cluster, not the leaf cluster (this is why they were held back from #13).
- **`nestjs-zod` 5** peers `@nestjs/common` ^10 || ^11 and `zod ^3.25.0 || ^4.0.0`. Our zod is **3.23.8**, so this cluster includes a **minor** bump to `zod` ≥ 3.25 (still v3). This does **not** pull in the zod 4 major — cluster 4 (zod 4) stays separate.

## Decision

**Adopt NestJS 11 + Express 5 + multer 2 in a single cluster PR**, with the coupled
peers above. Concretely, bump: `@nestjs/{common,core,platform-express,swagger,config,
bullmq,testing,cli}` → 11.x, `nestjs-zod` → 5, `zod` → ^3.25 (v3), `express` → 5,
`@types/express` (already 5), `@types/multer` → 2, `bullmq` → latest 5.x,
`@bull-board/{api,express}` → 7, `ejs` peer as required.

Drop the now-moot `path-to-regexp` `0.1.13` override afterwards (it pinned Express 4's
0.1.x tree; Express 5 uses path-to-regexp 8) — **verify** nothing else still pulls
0.1.x before removing.

## Breaking changes to handle

Our HTTP surface is almost entirely Nest-decorated, so Nest absorbs most routing
churn. The audit focuses on raw-Express touchpoints.

**Express 5 (via path-to-regexp 8 + API removals):**

- Route patterns: named wildcards required (`*` → `*splat`), optional-param and inline-regex syntax changed. Audit any string route patterns — chiefly the **`@bull-board/express` mount** and the global API prefix in `apps/api/src/main.ts`. _Implemented:_ the one affected pattern was the dev-user middleware `forRoutes("*")` in `apps/api/src/auth/auth.module.ts` → `forRoutes("{*splat}")`. The bull-board mount uses a plain prefix (`/admin/queues`) and needed no change.
- `req.query` is now a read-only getter — fail the build on any code that mutates it.
- Removed legacy signatures: `res.json(body, status)` / `res.send(status)`, `app.del()`, `req.param()`. Grep and fix.
- Rejected promises in middleware now forward to the error handler (an improvement; check no handler relied on the old swallow behaviour).

**multer 2:** option shape is compatible; the GPX upload uses `FileInterceptor("file", { limits: { fileSize: MAX_GPX_BYTES } })` (`apps/api/src/gpx/gpx.controller.ts`). Verify the size-limit rejection still surfaces as the same HTTP error, and that per-user GPX isolation is unaffected.

**NestJS 11:** lifecycle-hook ordering tweaks (`onModuleInit`/`onApplicationBootstrap`), reflect-metadata, and logger changes. The piscina worker pool ([ADR-0014](0014-planner-compute-worker-pool.md)) and BullMQ wiring need a smoke pass.

**`@bull-board` 7 export map:** v7 only exposes the adapter at the extensionless subpath `@bull-board/api/bullMQAdapter` (the old `@bull-board/api/bullMQAdapter.js` is no longer in `exports`). Updated the import in `apps/api/src/main.ts`.

**Peer-dep noise:** `@nestjs/swagger` 11 lists `@fastify/static`, `class-validator`, `class-transformer` as peers — optional for our platform-express + nestjs-zod setup; expect install warnings, not errors.

## Validation outcome (2026-06-05)

Executed on a feature branch and validated against the isolated dev stack (never the live UAT compose project):

- `pnpm audit --prod`: **no known vulnerabilities** — all advisories in the table above cleared, including the `uuid` path (`bullmq` 5.78 no longer drags the vulnerable `uuid@9` reachable code).
- Typecheck, lint, unit (96), and the **Testcontainers integration suite (10 files / 42 tests)** all green.
- `pnpm licenses:check`: pass — Express 5 / multer 2 / @bull-board 7 re-resolve introduced no SSPL/BUSL/etc. transitive.
- Playwright **upload smoke** (`apps/web/e2e/gpx-upload.smoke.spec.ts`, new): GPX upload → 3 caches ingested → Plan tab unlocks, exercising the multer 2 path end-to-end.
- Manual smoke: bull-board `/admin/queues` (UI + JSON API) and Swagger `/docs/api` both serve on Express 5; the upload's `walking-precompute` jobs completed (BullMQ + Valkey healthy).
- `path-to-regexp` `0.1.13` override removed; whole tree now resolves to `path-to-regexp` 8.4.2.

## Validation (gating)

This cluster touches the HTTP + DB + queue layers, so local unit/typecheck is **not
sufficient**. Required before merge ([dependency-upgrades.md](../sdlc/dependency-upgrades.md)
checklist):

- Testcontainers **integration tests** (real PostGIS, full request path) — needs Docker.
- Playwright **e2e** against the compose stack (GPX upload → plan → map) — the upload
  path rides multer 2, so this is mandatory.
- `pnpm licenses:check` — Express 5 / multer 2 / @bull-board 7 re-resolve a large
  subtree; re-confirm GPLv3 compatibility ([ADR-0003](0003-license-gplv3.md)).
- Manual `/queues` (Bull dashboard) smoke check — it moved to Express 5.

## Consequences

- Clears all remaining runtime advisories; gets the framework onto a supported major.
- One larger-than-usual PR. It is still **one logical change** (the framework major and
  its forced peers) and is bisectable against clusters 1–2, which are already on `main`.
- Establishes `zod` ≥ 3.25 as the floor, de-risking the later zod 4 cluster.
- **Reversible** by revert (no migrations, no data changes) — but UAT must be
  redeployed and smoke-checked after, since UAT tracks `main`.

## Alternatives considered

- **Stay on Nest 10, override `multer`/`file-type`.** Rejected: `@nestjs/platform-express`
  10 pins multer 1.x and the `@nestjs/core` fix is 11-only; overrides can't reach them
  without breaking the framework.
- **Fold zod 4 into this cluster** (since `nestjs-zod` 5 allows it). Rejected: zod is the
  shared wire contract (api ↔ web); its blast radius is different and deserves its own
  PR. `nestjs-zod` 5 runs fine on zod 3.25, so the coupling is satisfied without it.
