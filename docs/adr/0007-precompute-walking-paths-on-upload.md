# ADR-0007 — Precompute walking paths + landuse on GPX upload

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Raimond Brookman (owner)

## Context

The route-planner runs Pass 1 (cluster discovery) and Pass 2 (routed loop) on every `/tours/clusters` and `/tours/plan` call. Both passes ultimately need walking distances between geocaches. Pass 1 builds a sparse k-NN walking graph and partitions it with Louvain; Pass 2 builds a full N×N matrix for the chosen cluster and TSP-solves it.

The walking distances are cached in `route_legs` and re-used on subsequent requests, but the *first* request after an upload pays the full OSRM `/table` cost — and on a recently-uploaded PQ that can be tens of seconds. The user's pain point: opening the map after a fresh upload, picking an area, and waiting for the planner to "warm up."

OSM landuse has a similar shape — the soft-preference scoring needs polygons around the cluster, but the `osm_landuse` cache is only populated when a user actually navigates to that area. First-visit latency hurts.

Both caches' content is fully predictable from the set of caches that exist. There's no reason it has to be computed lazily on user action.

## Decision

On GPX upload completion, enqueue two BullMQ jobs:

1. **`walking-precompute`** — for each new cache, find its top `k_candidates = max(PLANNER_KNN_K*3, PLANNER_KNN_K+5) = 36` haversine neighbours within `PLANNER_PRECOMPUTE_RADIUS_M = 3000m` (PostGIS `ST_DWithin` ordered by `<->`). Also find every existing cache within 3 km of any new cache — these are "affected" caches whose top-k changes because of the new arrivals. Call OSRM `/table` in chunks for all required pairs, persist to `route_legs` via the existing `RoutingRepository.upsertMatrixCells` (idempotent, version-stamped).
2. **`overpass-refresh`** — compute the convex hull of the new caches' locations + a 500 m buffer; refresh landuse for the cells it touches via the existing `OsmService` refresh path (skip cells whose newest row is fresher than 7 days).

Track per-(cache, kind) freshness in a new `cache_precompute_state` table. State transitions: `pending → in_progress → fresh | failed`. Surface freshness as a SQL view `v_stale_caches` so the admin endpoint and a future housekeeping job share one definition of "stale."

Operator surface:
- **Bull-Board** mounted at `/admin/queues` for live queue ops (pause/retry/clean).
- **Custom `/admin/jobs` page** with per-kind summary tiles, failed-list table, and a "retrigger stale" button.
- **Admin API** (`/admin/precompute/*`) endpoints back both views.

## Why 3 km haversine cap

The Pass-1 cluster graph already over-fetches haversine neighbours at `min(maxLinkMeters * 2, 4000)` — with the default `maxLinkMeters = 1500`, that's exactly **3000 m** (see `apps/api/src/tours/strategies/greedy/clustering/context.ts`). Matching the precompute cap to the runtime cap guarantees the precomputed cells cover every pair the runtime would compute, with no waste.

Empirical data on the current ~3,500-cache DB (Phase-1 exploration):

| Cap | Directed pairs | Caches with ≥1 neighbour |
|---|---|---|
| 1 km | 27k | 87% |
| 2 km | 70k | 96% |
| **3 km** | **119k** | **98%** |
| 5 km | 243k | 99% |

A 5 km cap would over-compute pairs the cluster graph would discard. A 2 km cap drops the affected-set for sparse regions. 3 km is the sweet spot.

## Why per-batch jobs, not per-cache or debounced

- **Per-cache** — N jobs per upload = N×OSRM round-trips. The OSRM `/table` cost is amortized over many origins in one call, so coalescing matters.
- **Debounced** — a 5-minute window after the last upload would let three back-to-back GPX uploads share one job. Saves work but adds a 5-minute "not cluster-ready yet" window the user can't predict. Per-batch is simpler and the win from debouncing is small (uploads aren't bursty).
- **Per-batch** — one job per upload completion. The job payload is the list of newly-affected `cache_id`s (from `GpxRepository.upsertFromGpx`'s `cacheIdByCode`). Coalesces well; predictable latency.

## Why we recompute affected existing-cache neighbours

The k-NN graph is symmetric in spirit even though edges are walked in both directions: if cache X is added near an existing cluster of A/B/C, then A's top-12 walking neighbours may now include X. Without recomputing A/B/C, the cluster graph at request time would either re-fetch them inline (defeating the precompute) or miss the new edges (wrong clusters). Recomputing the "affected set" (every existing cache within 3 km of any new cache) is bounded by the same haversine cap, so the work stays proportional to the new-cache count × local density.

## Why bull-board + custom admin page

- **Bull-Board** is the off-the-shelf BullMQ dashboard (MIT, GPLv3-compatible). It gives queue-level ops (pause, retry, clean failed) for free. Re-implementing all of that would be wasted effort.
- **Custom `/admin/jobs` page** gives the *per-cache* view bull-board can't (it sees queue state, not domain state) — freshness counts per kind, list of stale/failed caches, single-click "retrigger stale" that knows the domain model.
- Both surfaces stay gated behind the existing dev-user middleware until M6 ships proper auth.

## Why a new `cache_precompute_state` table over columns on `caches`

- Multiple kinds per cache (walking, landuse, and possibly tile-prewarm later) with independent state.
- Keeps the hot `caches` table lean.
- Clean foreign-key cascade.
- The 30-day staleness check is a single indexed query on `(kind, state, osrm_version, fetched_at)` rather than scanning `caches`.

## Consequences

**Good**

- First post-upload `/tours/clusters` call returns in < 200 ms (vs. ~seconds today on a cold cache).
- Landuse-weighted soft preference (deferred from M3, picked up in M5-β) has data ready when the user opens the area.
- Operator has a single dashboard to confirm uploads have been fully processed.
- Re-triggering after an OSRM extract bump is a click, not a database wipe.

**Trade-offs**

- Adds two BullMQ queues + Valkey dependency (already planned for M4-β; this commits to it).
- Adds an `@bull-board/api` + `@bull-board/express` dep; verified MIT.
- A new migration + Kysely type updates (per [docs/sdlc/migrations.md](../sdlc/migrations.md)).
- The admin API is initially gated only by dev-user middleware — must be revisited when M6 lands auth.
- The job storm on a "My Finds" PQ upload (~thousands of new cache rows) needs to be bounded — chunk the OSRM `/table` calls so a single job's runtime stays reasonable.

**Not in scope here**

- Full backfill for an already-populated DB. That's a one-shot operator script invoking the same precompute logic — not part of M4-β's automatic upload trigger.
- Pass-2 full-cluster matrix precompute. Defer unless field measurements show Pass 2 is still the slow path after this lands.
- Time-based eviction of `route_legs` rows. Today only version-mismatch evicts; that's enough.
