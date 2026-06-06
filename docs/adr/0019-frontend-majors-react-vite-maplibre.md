# ADR-0019 — Frontend majors: React 19 + Vite 8 + maplibre-gl 5 + Vitest 4

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0016](0016-staged-dependency-upgrades.md) (the staged strategy this is cluster 5 of), [ADR-0017](0017-nestjs-11-express-5-migration.md) (cluster 3), [ADR-0018](0018-zod-4-shared-wire-contract.md) (cluster 4), [ADR-0001](0001-stack-choices.md), [ADR-0003](0003-license-gplv3.md)

## Context

Cluster 5 of the staged dependency upgrade ([ADR-0016](0016-staged-dependency-upgrades.md))
and the **highest-blast-radius** tier — the browser app's framework, build tool,
test runner, and map engine all move a major at once. Clusters 1–4 are merged and
UAT-deployed; `main` is green and nothing of cluster 5 has started.

Unlike cluster 3 this clears **no security advisory** — it is a currency move — but
its risk profile is the inverse of the wire-contract cluster: the danger is not
type-inference ripple, it is **runtime/visual regression in the map UI that no
type-checker catches**. `apps/web` ships **zero unit tests** (its Vitest run is
`--passWithNoTests`; the only Vitest specs that execute are the 6 in
`packages/shared`, node env), so the existing behavioural safety net is a **single**
Playwright smoke (`apps/web/e2e/gpx-upload.smoke.spec.ts`). That gap, against a
maplibre major, is the central concern of this cluster — addressed in the Decision.

### Exact bumps (current → latest stable, audited 2026-06-05)

| Package                | From    | To          | Location                         |
| ---------------------- | ------- | ----------- | -------------------------------- |
| `react`                | 18.3.1  | **19.2.7**  | apps/web deps                    |
| `react-dom`            | 18.3.1  | **19.2.7**  | apps/web deps                    |
| `@types/react`         | 18.3.12 | **19.2.17** | apps/web devDeps                 |
| `@types/react-dom`     | 18.3.1  | **19.2.3**  | apps/web devDeps                 |
| `vite`                 | 5.4.11  | **8.0.16**  | apps/web devDeps                 |
| `@vitejs/plugin-react` | 4.3.4   | **6.0.2**   | apps/web devDeps                 |
| `vitest`               | 2.1.9   | **4.1.8**   | **apps/web AND packages/shared** |
| `jsdom`                | 25.0.1  | **29.1.1**  | apps/web devDeps                 |
| `maplibre-gl`          | 4.7.1   | **5.24.0**  | apps/web deps                    |

**Held back (not this cluster):** `@playwright/test` 1.60.0 (already latest),
`@tanstack/react-query` 5.101.0 (already v5; peer `react ^18 || ^19`,
React-19-ready), `typescript` 5.6.3 → cluster 6.

### Why these move as one cluster (verified peers)

- `@vitejs/plugin-react@6` **peer-requires `vite ^8.0.0`** — plugin-react 6 ↔ vite 8
  are locked and bump together. (plugin-react 6 lists optional peers
  `babel-plugin-react-compiler` + `@rolldown/plugin-babel`; opt-in, ignored.)
- `vitest@4` peer `vite ^6 || ^7 || ^8` — fine on vite 8. Vitest must move in
  **both** `apps/web` and `packages/shared` or the monorepo gets a split Vitest
  version.
- The React quartet (`react`, `react-dom`, `@types/react`, `@types/react-dom`) moves
  to 19 together.
- **Node engine bump REQUIRED.** vite 8, plugin-react 6, and jsdom 29 all require
  node `^20.19.0 || >=22.12.0`. Root `package.json` `engines.node` is `">=20"` (too
  loose). It must become `^20.19.0 || >=22.12.0`. CI runs node 22 (✓); only the
  declared range is stale. Vitest 4 peer wants `@types/node ^20 || ^22 || >=24`
  (none pinned in web today — add only if install demands it).

maplibre-gl 5 (BSD-3-Clause) is not peer-coupled to the toolchain, but it is the
highest-risk single bump, so it rides this cluster rather than getting its own — and
is sub-committed last so it stays bisectable.

## Decision

**Adopt React 19 + Vite 8 + `@vitejs/plugin-react` 6 + Vitest 4 + jsdom 29 +
maplibre-gl 5 in a single cluster PR on its own branch (`chore/deps-frontend`),
green before merge.** Bump the root `engines.node` range in the same PR. Keep
`@tanstack/react-query`, `@playwright/test`, and `typescript` where they are.

**Add Playwright e2e coverage as part of this cluster** (not deferred). The web app's
only behavioural net is one upload smoke, and the flow that broke in cluster 4 —
**"Discover clusters"** — still has _zero_ e2e (the lesson of
`zod4-uuid-guid-gotcha`: feed prod-shaped data through e2e). Before/with the code,
add Playwright coverage for: **map renders**, **"Discover clusters"**, **cluster
focus**, and a **plan render**, run against `pnpm dev`. maplibre-5 regressions
surface here, not in `typecheck` — so e2e, not the type gate, is the real gate for
this cluster.

### Staged sub-commits (bisectable, one PR)

Per [ADR-0016](0016-staged-dependency-upgrades.md) ("don't big-bang"), the single PR
is built from sub-commits so a red gate points at one major:

1. **Toolchain, React-18-held.** vite 5→8 (step 5→6→7→8 only where a step breaks;
   jumping straight is allowed while green), bumping `@vitejs/plugin-react` to the
   matching major and `vitest` 2→4 + jsdom 29 alongside. Green build + typecheck each
   step → any break is unambiguously tooling, not React/maplibre.
2. **React 18→19** + `@types/react`/`@types/react-dom` 19 + react-dom. Clear the
   `@types/react` 19 typecheck fallout.
3. **maplibre-gl 4→5.** Verify every map layer via new + existing e2e.

### As shipped

Landed on `chore/deps-frontend` as the three sub-commits above plus an e2e commit.
The bumps needed only small, well-understood fixes — the audit held:

- **Toolchain.** Vite 8 transforms TS via **oxc**, which (unlike `tsc`) resolves a
  nested tsconfig `extends` against the **pnpm symlink dir** rather than the
  package's real path — so the `@gctp/config/...` specifier broke the web build and
  the shared vitest run (`Tsconfig not found`). Switched the two vite/oxc-processed
  tsconfigs (`apps/web`, `packages/shared`) to a **relative `extends`**; `apps/api`
  and `packages/db` are `tsc`-only and keep the specifier. vite 5→8 was taken in one
  step (stayed green). No 5→6→7 stepping was needed.
- **React 19.** Exactly the predicted `@types/react` 19 fallout: the global `JSX`
  namespace moved under `react`, so eight files got `import type { JSX } from "react"`
  (usage sites untouched); and one `<li ref={el => map.set(...)}>` returned a value,
  which React 19 now treats as a cleanup function — wrapped in a block. No
  `defaultProps`/`forwardRef`/string-ref work, as audited.
- **maplibre-gl 5.** maplibre 5 no longer pulls `@types/geojson` into the program, so
  the global `GeoJSON.*` namespace the 15 map files use vanished — declared
  `@types/geojson` as a direct devDep and added `"geojson"` to the web tsconfig
  `types` array (which pins `types: [...]`, otherwise excluding it). And
  `Evented.on()` now returns a `Subscription`, not `this`, so the chained
  `new Popup().on("close", …)` in `WalkingGraphLayer` no longer yields a `Popup` —
  built on a local and assigned the ref after. No other runtime breakage surfaced.

The new e2e (`apps/web/e2e/map-cluster-plan.smoke.spec.ts`) covers map render +
upload → Discover clusters → cluster focus → planned loop, with a
pageerror/console-error collector that fails on any real runtime throw. All three
specs (plus the existing upload smoke) pass against a vite-8 / React-19 /
maplibre-5 `pnpm dev` stack — confirming no maplibre-5 runtime regression. The
"Discover clusters" path now has e2e for the first time. `licenses:check` stayed
clean (maplibre-gl 5 = BSD-3-Clause, vite 8 = MIT; no SSPL/BUSL transitive drift).

> Noted in passing (not fixed here — out of scope for a deps bump): the sidebar
> tab buttons carry `aria-controls="sidebar-tabpanel"` but the tabpanel `<div>` has
> no matching `id`, so the reference dangles. Worth a small a11y follow-up.

## Breaking changes / blast radius (audited in `apps/web/src`)

**React 19 — source risk LOW.** Zero `defaultProps` / `propTypes` / `forwardRef` /
`ReactDOM.render` / string-refs. Already on `createRoot` (`main.tsx`). Note
`CachesLayer.tsx:326` mounts a `createRoot` _inside_ a maplibre marker — a React-19 ×
maplibre-5 interaction point; verify markers/popups still render. The real React-19
pain is **`@types/react` 19 type fallout**: implicit `children` removed from `FC`,
`JSX` namespace moved to `React.JSX`, tightened `ReactNode`. It surfaces in
`pnpm typecheck`, the type gate.

**maplibre-gl 4→5 — the main event, HIGH risk.** 15 files under
`apps/web/src/features/map/` import `maplibre-gl`: MapView, MapContext, CachesLayer,
ClustersPreviewLayer, ParkingPreviewLayer, OsmParkingLayer, LanduseLayer, TourLayer,
RadiusLayer, WalkingGraphLayer, TestRouteLayer, LegAlternativePreviewLayer,
LegViaPointLayer, ParkingOwnerLinkLayer (+ App.tsx). Read the maplibre v5 migration
guide; expect removed-deprecated-method and option-shape changes. `typecheck` will
not cover runtime/visual regressions — **e2e is the gate here.**

**Vite 8 / plugin-react 6 / Vitest 4 / jsdom 29 — toolchain.** Config-shape and
default changes; caught by the prod build (`pnpm --filter @gctp/web build`) and the
Vitest runs. jsdom 29 backs the web Vitest env (presently no specs) and could affect
`packages/shared` only if its node-env specs touched DOM (they don't).

## Validation (gating)

maplibre-5 runtime regressions don't show in typecheck, so the behavioural gate is
e2e, not the build. Gate order on this box (LIVE UAT — same cautions as cluster 4):

1. `pnpm --filter @gctp/db --filter @gctp/shared build` (workspace deps first).
2. **`pnpm typecheck`** across the monorepo — catches `@types/react` 19 fallout.
3. `pnpm lint`, `pnpm test` (the 6 shared Vitest specs; web is `--passWithNoTests`).
4. **`pnpm --filter @gctp/web build`** — the vite-8 prod build.
5. **Playwright e2e against `pnpm dev`** — existing upload smoke **+ the new map /
   Discover-clusters / cluster-focus / plan-render specs**. This is the real gate.
6. **`pnpm licenses:check`** — frontend majors can drag SSPL/BUSL transitives through
   the maplibre/vite ecosystems. maplibre-gl 5 = BSD-3-Clause and vite 8 = MIT (both
   verified OK), but re-run the full check. It exits 0 today; the lone
   `UNLICENSED: 1` is the root monorepo package (expected).

Validate against the isolated `gctp-dev` stack (`pnpm dev`; ports postgres 15432 /
valkey 16379 / web 5173 / api 3030 — dev api has **no `/api` prefix**, health is
`http://localhost:3030/health`). **Never** `cd infra && docker compose up` for feature
validation — that is the live `gctp` project and collides with running UAT.

## Consequences

- Gets the browser stack onto supported majors (React 19, Vite 8, maplibre 5, Vitest 4) and closes the largest version gap in the repo. Establishes them as the floor for
  future frontend work.
- **Net-positive on test coverage:** the cluster leaves behind real e2e for the map
  and the cluster-discovery flow that had none — durable value beyond the bump.
- One larger-than-usual PR, but **one logical change** (the frontend majors and their
  forced peers), bisectable via the staged sub-commits, and individually revertable.
- **Reversible by revert** (no migrations, no data changes); UAT redeploys from `main`
  after merge and gets an edge smoke, as every cluster.
- Leaves cluster 6 (TypeScript 6) as the last tier — or a deliberate hold.

## Alternatives considered

- **Split maplibre into its own cluster.** Tempting (it carries the runtime risk and
  is not peer-coupled to the toolchain), but it would mean a second full frontend
  e2e + UAT round-trip for one dep. Folding it in — sub-committed last — keeps the
  bisect signal while paying the e2e/redeploy cost once.
- **Big-bang all four majors in one commit on the branch.** Rejected per
  [ADR-0016](0016-staged-dependency-upgrades.md): a red gate would give no signal
  about which major broke it. The staged sub-commits preserve that signal inside a
  single PR.
- **Defer the new e2e to a follow-up and gate on typecheck + the upload smoke alone.**
  Rejected: typecheck cannot see maplibre-5 runtime regressions and the upload smoke
  never touches the cluster/plan/map-render paths — the exact surface this cluster
  most endangers. Shipping a maplibre major behind that net is the cluster-4 mistake
  one layer down.
- **Stay on React 18 / Vite 5.** Rejected: maintenance drift only grows, and Vite 5 /
  Vitest 2 fall out of support windows; deferring just enlarges the eventual jump.
