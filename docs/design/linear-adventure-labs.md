# Linear Adventure Labs — in-order routing + cluster-forming toggle

> **Status: Planned — not yet implemented.** This is the agreed implementation
> plan for linear-AL support. File/line references are accurate as of the
> `feat/al-followups-drop-reasons-manual-clusters` branch and may drift; treat
> them as starting points. Related: FR-I16/FR-I17 (PR #90), FR-T14
> (manual/editable clusters).

## Context

Adventure Labs (ALs) come in two flavours: **random-order** (stages visitable
in any sequence — already supported) and **linear** (stages must be completed in
`S1 → S2 → S3 …` order). The planner currently treats every AL as random-order:
the solver enforces *atomicity* (all stages or none) and *contiguity* (one block
when interleave is off), but never *ordering*. So a linear AL can be routed out
of sequence, producing a tour you can't actually walk.

This change adds **linear-AL support**: stages of a linear adventure appear in
the route in `stageSequence` order, while ordinary caches (and other adventures'
stages) may still interleave between them. It also adds a **per-discovery user
toggle** to include/exclude ALs from cluster forming.

Two prior decisions shape the design (FR-I16/FR-I17, PR #90): the **Timefold
solver** is the AL path (`TOUR_PLANNER=auto` routes to it whenever ALs are in the
candidate set; greedy stays the non-AL fast path), and each adventure is
**collapsed to one node** for clustering. The DB already carries an
`adventure_sequential BOOLEAN` column (migration `1782…`, reserved, **never
populated**), and `stageSequence` is already wired through the TS→Java solver
wire **but unused**. The only missing piece on the data side is *where linearity
comes from*.

**Confirmed decisions:**

1. Cluster toggle OFF ⇒ **exclude ALs from the clustering candidate pool
   entirely** (plan them via the manual-cluster editor FR-T14 or nearby-AL
   pull-in). Default ON = today's collapsed behaviour.
2. The cluster toggle governs **all ALs**; in-route **ordering is enforced only
   for adventures flagged linear**. Random-order ALs keep today's
   atomicity/contiguity behaviour.

## Linearity data source (the key finding)

Lab2Gpx knows each adventure's `IsLinear` flag (from the GC Adventure API) and
exposes a `linear` request enum: `default | first | mark | corrected | ignore`.
We currently send `linear: "default"` (no marking). In **`mark`** mode, linear
adventures keep *every* stage's posted coordinate **and** prefix
`<groundspeak:name>` with `[L] ` (verified in the lab2gpx `gpx.xml.twig`
`getWaypointTitle` macro). Our parser already reads the cache name from
`<groundspeak:name>` (`packages/shared/src/gpx/parse.ts`), so flipping the
enricher to `mark` and detecting the `[L] ` prefix is the minimal,
coordinate-preserving way to populate `adventure_sequential`. (Lab2Gpx emits
**no** explicit `<lab2gpx:isLinear>` element — `mark` is the only viable signal,
and we have no direct GC AL creds.)

## Implementation

### A. Ingest linearity (`adventure_sequential`)

- **Enricher** `apps/api/src/sources/adventure-lab/al-enricher.service.ts`:
  change `linear: "default"` → `linear: "mark"`. Update the adjacent comment
  (mark keeps coords AND tags linear adventures; FR-I17 backfill `fetchAreaGpx`
  inherits this).
- **Parser** `packages/shared/src/gpx/parse.ts`: in `toParsedCache` detect a
  leading `[L]` on `gs["groundspeak:name"]` → set `adventureSequential: boolean`
  (true/false; `null`/false for non-AL). **Strip** the `[L] ` prefix from the
  stored `name`. Add `adventureSequential` to the returned object alongside
  `adventureId`/`stageSequence`/`stageTotal`. (Belt-and-braces: only treat as
  linear when `adventureId` is also present.)
- **ParsedCache type** `packages/shared/src/gpx/types.ts`: add
  `adventureSequential: z.boolean().nullable().default(null)`.
- **Ingest upsert** `apps/api/src/gpx/gpx.repository.ts`: write
  `adventure_sequential` in both the insert column list and the
  `excluded.adventure_sequential` update branch (mirror the existing
  `stage_total` handling).
- **No migration needed** — column + `packages/db/src/schema.ts` already have it.

### B. Surface the flag to the planner

- **Repository** `apps/api/src/caches/caches.repository.ts`: project
  `adventure_sequential` in the `CacheRow` select + map it into the DTO as
  `adventureSequential` (mirror `stageSequence`).
- **Shared Cache schema** `packages/shared/src/caches/index.ts`: add
  `adventureSequential: z.boolean().nullable().default(null)` to both cache
  shapes and the mapper. Additive + defaulted ⇒ back-compat for any persisted
  shape.

### C. Solver: enforce stage order for linear adventures

TS adapter `apps/api/src/tours/strategies/solver/`:

- **`solver-client.ts`** `SolverPlanRequest.caches[]`: add
  `adventureSequential: boolean` (beside the already-present `stageSequence`).
- **`solver-tour-planner.ts`**: send `adventureSequential: c.adventureSequential
  ?? false` in the request map. `collapseColocated` already orders co-located
  members by `stageSequence` — keep it; the constraint covers *non-co-located*
  spread stages. The AL-aware post-solve trim already drops whole adventures —
  no change.

Java sidecar `infra/solver/src/main/java/com/gctp/solver/`:

- **`domain/Cache.java`**: add `Integer stageSequence` + `boolean
  adventureSequential` (+ getters/setters).
- **`rest/PlanRequest.java`** `CacheInput`: add `adventureSequential` (and
  confirm `stageSequence` is already present in the record).
- **`service/PlanService.java` `toProblem`**: `cache.setStageSequence(...)`;
  `cache.setAdventureSequential(...)`.
- **`domain/Tour.java`**: add `long orderingViolationPenalty()` — for each cache
  whose `adventureSequential` is true, within its adventure count visit-order
  inversions (a stage appearing after a higher-sequence stage of the same
  adventure). Data-driven per-cache; **no new tour-level request flag**
  (linearity is intrinsic).
- **`solver/TourConstraintProvider.java`**: add `adventureOrdering(factory)` as a
  **HARD** constraint (`HardMediumSoftLongScore.ONE_HARD`, penalize by
  `orderingViolationPenalty`), register it in `defineConstraints()`. Sits beside
  `adventureAtomicity`/`adventureContiguity`; orthogonal to `adventureInterleave`
  (interleave controls contiguity, ordering controls sequence).
- **Tests** `TourConstraintProviderTest`: linear AL ordered `1→2→3` ⇒ 0 penalty;
  `1→3→2` ⇒ penalty; `1→plain→2→3` interleaved-but-ordered ⇒ 0 penalty;
  non-linear AL unaffected.

*Greedy path note:* ordering is solver-only (consistent with atomicity). With
`TOUR_PLANNER=auto`, any AL set already routes to the solver, so this is the live
path. Document that a forced `TOUR_PLANNER=greedy` won't order linear stages.

### D. Cluster-forming toggle (exclude ALs from Pass-1 pool)

- **Shared schema** `packages/shared/src/tours/plan-input.ts`: add
  `includeAdventuresInClustering: z.boolean().default(true)` to `PlanInput`.
- **Clustering context**
  `apps/api/src/tours/strategies/greedy/clustering/context.ts`: when
  `input.includeAdventuresInClustering === false`, **drop** all `type ===
  "Adventure Lab"` caches from the candidate `caches` before the
  walking-graph/collapse step (empty `adventureExpansion`). When true, keep
  today's `collapseAdventures(caches)`. (Exclude-from-pool, not just
  no-collapse.)
- **Frontend**:
  - `apps/web/src/features/planning/PlannerSidebar.tsx`: add
    `includeAdventuresInClustering: boolean` to `PlanSettings` +
    `DEFAULT_PLAN_SETTINGS` (true), and a checkbox in the cluster-discovery
    controls (near `minClusterSize`/`clusteringStrategy`, since it's a Pass-1
    knob — *not* with the Pass-2 atomicity/interleave checkboxes).
  - `apps/web/src/App.tsx` `discoverMutation`: pass
    `includeAdventuresInClustering: planSettings.includeAdventuresInClustering`
    into `discoverClusters(...)`.

### E. UI niceties (small, optional within this PR)

- Show a linear badge: thread `adventureSequential` into the cache popup / AL
  rendering so a linear AL is visually distinguishable (e.g. an "L"/"linear"
  chip). Reuse the existing `CachePopup` prop-passing pattern. Low effort; keep
  if it fits, otherwise note as follow-up.

### F. Docs (required — docs-in-sync rule)

- `docs/requirements/ingest.md` (or tour-planning.md): new FR for linear-AL
  ordering + the cluster-forming toggle (e.g. FR-I18 / FR-T15).
- `docs/design/tour-planning.md`: the `adventureOrdering` HARD constraint + the
  Pass-1 AL-exclusion toggle.
- `docs/PLANNER_TUNING.md`: note ordering is solver-only; `linear: "mark"`
  enricher mode.
- `apps/web/src/features/landing/LandingPage.tsx`: marketing parity — mention
  linear-AL support + the AL clustering choice.
- `infra/.env.example` if any new knob is added (none expected).

## Operational note

`adventure_sequential` is `NULL` for all currently-imported AL rows. After
deploy, **re-run the FR-I17 admin backfill** (`POST
/admin/adventure-labs/backfill-ids`, now fetching in `mark` mode) or re-import
GPX to populate linearity. Until then linear ALs behave as random-order (safe
degradation). This is an owner/admin action (needs
`ADVENTURE_LAB_ENRICHMENT_ENABLED=1`, admin session).

## Verification

- **Unit (shared):** `pnpm --filter @gctp/shared test` — add a `parse.spec.ts`
  case: a `[L] Title : S1 …` groundspeak name ⇒ `adventureSequential: true` and
  name stripped to `Title : S1 …`; non-`[L]` ⇒ false; round-trips
  `stageSequence`.
- **Java:** `cd infra/solver && docker run --rm -v "$PWD":/build -v
  gctp-m2:/root/.m2 -w /build maven:3.9-eclipse-temurin-21 mvn -B clean test` —
  new ordering tests green (CI image build skips Java tests).
- **Integration (api, Testcontainers):** extend an AL ingest/repository spec to
  assert `adventure_sequential` persists and surfaces in the DTO; assert
  `includeAdventuresInClustering:false` drops AL caches from discovery.
- **API suite + types + lint:** `pnpm --filter @gctp/api test`, `pnpm
  typecheck`, `pnpm lint`, `pnpm format:check`.
- **Web:** `pnpm --filter @gctp/web test` + `build`; manual smoke — toggle
  "include ALs in clustering" off ⇒ discovered clusters contain no AL stages.
- **End-to-end on UAT** (owner step): flip enricher to `mark`, redeploy `api jobs
  solver` (+ restart `web` for nginx upstream), run the backfill, then plan a
  loop over a known **linear** AL and confirm stages route `S1→S2→…` with normal
  caches allowed between them; confirm a **random-order** AL is unchanged.

## Critical files

- `apps/api/src/sources/adventure-lab/al-enricher.service.ts` (enricher `linear:
  mark`)
- `packages/shared/src/gpx/parse.ts`, `packages/shared/src/gpx/types.ts` (parse
  `[L]` → `adventureSequential`)
- `apps/api/src/gpx/gpx.repository.ts` (upsert column)
- `apps/api/src/caches/caches.repository.ts`,
  `packages/shared/src/caches/index.ts` (DTO surface)
- `apps/api/src/tours/strategies/solver/{solver-client.ts,solver-tour-planner.ts}`
  (wire)
- `infra/solver/src/main/java/com/gctp/solver/{domain/Cache.java,domain/Tour.java,rest/PlanRequest.java,service/PlanService.java,solver/TourConstraintProvider.java}`
  + test (ordering constraint)
- `packages/shared/src/tours/plan-input.ts`,
  `apps/api/src/tours/strategies/greedy/clustering/context.ts` (cluster toggle)
- `apps/web/src/features/planning/PlannerSidebar.tsx`, `apps/web/src/App.tsx`
  (UI toggle)
- docs (ingest/tour-planning/PLANNER_TUNING/LandingPage)
