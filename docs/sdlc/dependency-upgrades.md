# Dependency upgrades

How we keep dependencies current without betting the app on one un-reviewable diff. The _why_ behind this approach is [ADR-0016](../adr/0016-staged-dependency-upgrades.md); this page is the operational how-to.

## Principle: staged clusters, not big-bang

We do **not** run `pnpm update --latest` across the tree in one branch. Several breaking majors landing together is un-bisectable — when CI goes red you can't tell which major did it — and the risky ones (HTTP/DB layer, the browser app) can't be behaviourally validated without the Docker integration + Playwright e2e stacks.

Instead, upgrades land as **clusters**, each its own branch/PR, green before the next. A cluster groups packages that _must_ move together (peer-coupled) and excludes anything that would drag in an unrelated breaking major.

## Cluster ordering

Roughly lowest-risk → highest-blast-radius. Current state:

| #   | Cluster                                                                                           | Status                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Runtime security pass** — low-churn overrides + within-major patch bumps for live advisories    | ✅ merged (#11, #12)                                                                                                                                                                 |
| 2   | **Leaf bumps** — packages with no breaking peer coupling (fast-xml-parser, kysely, pino, tooling) | ✅ merged (#13)                                                                                                                                                                      |
| 3   | **NestJS 11 + Express 5 + multer 2 + bullmq/@bull-board**                                         | ✅ merged (#17) — [ADR-0017](../adr/0017-nestjs-11-express-5-migration.md) (Accepted); cleared all runtime advisories, UAT redeployed                                                |
| 4   | **zod 4 (nestjs-zod stays 5)** — the shared wire contract                                         | ✅ merged (#19) — [ADR-0018](../adr/0018-zod-4-shared-wire-contract.md) (Accepted); currency-only (no advisory), bump + 6-line deprecation cleanup, UAT redeployed                   |
| 5   | **Frontend** — React 19 + maplibre-gl 5 + Vite (step 5→6→7→8) + Vitest 4                          | ✅ merged (#22) — [ADR-0019](../adr/0019-frontend-majors-react-vite-maplibre.md) (Accepted); currency-only (no advisory), added map + Discover-clusters e2e, UAT redeployed          |
| 6   | **TypeScript 6**                                                                                  | 🟡 ADR proposed — [ADR-0020](../adr/0020-typescript-6.md); typescript-only (tse/tsc-watch already TS6-ready), typecheck is the gate. Last cluster — ship-vs-hold is the owner's call |

A bump's cluster is decided by its **coupling**, not its name. Example: `bullmq` looks like a leaf, but 5.78 widens `JobProgress` to include `string` (breaking `@bull-board/api` 6.5), and every newer `@bull-board` peer-requires `express ^5.2.1` — so `bullmq` belongs in cluster 3, not 2.

## Triage: not every advisory needs a code change

For each open advisory, decide **reachability** before reaching for a bump:

- **Reachable** → fix it (override to the patched version, or move the owning cluster forward).
- **Not reachable** → document why in the PR body and leave it. Forcing a cross-major override against an exact pin can break more than it fixes.

Examples currently triaged as not-reachable:

- `fast-xml-parser` XMLBuilder advisory — we only use `XMLParser` to parse GPX. (Closed anyway by the cluster-2 bump to v5.)
- `uuid` v3/v5/v6-with-`buf` advisory — the only consumer is `bullmq`'s `uuid@9` `v4()` ID generation.
- `file-type` DoS — only invoked via Nest's `FileTypeValidator`/`ParseFilePipe`, which we don't use (GPX upload uses `FileInterceptor` only).

## Choosing override vs. dependency bump

- **`pnpm.overrides`** (in the root `package.json`) — for a vulnerable **transitive** dep where the direct parent hasn't shipped a fix yet, and the patched version is API-compatible. Pin the exact patched version; re-evaluate at each pass (a stale override can fall behind a re-scored advisory — e.g. `path-to-regexp` 0.1.12 → 0.1.13).
- **Direct version bump** — for a dep we declare. Stay within the current major unless the cluster is explicitly a major migration.

## Per-cluster checklist

1. Branch off `main` (`chore/deps-<cluster>` or an `<area>/<slug>` for migration work).
2. Apply the bumps; `pnpm install`; commit `package.json` + `pnpm-lock.yaml` together.
3. Local gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, **`pnpm licenses:check`** (a major can drag in an SSPL/BUSL transitive — the GPLv3 gate is mandatory, see [LICENSING.md](../LICENSING.md)).
4. For clusters touching the HTTP/DB layer, run the Testcontainers integration tests; for clusters touching the API↔web boundary, run Playwright e2e.
5. Open one PR per cluster (see [branching-and-prs.md](branching-and-prs.md)); list what was **held back** and why.
6. A breaking-major cluster gets an ADR (status `Proposed`) before the code PR.
