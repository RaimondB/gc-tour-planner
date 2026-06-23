# Precompute — walking paths on upload

Background jobs that fire on GPX upload completion and warm the caches the route planner reads at request time. Rationale: [ADR-0007](../adr/0007-precompute-walking-paths-on-upload.md). User-facing requirement: [requirements/ingest.md FR-I8](../requirements/ingest.md).

**Update (ADR-0009)**: the per-upload `overpass-refresh` queue is gone. Landuse polygons are now imported region-wide via osm2pgsql once at compose-up time and refreshed daily by `landuse-replication`. Caches uploaded into the region pick up landuse memberships via the existing lazy `populate_cache_landuse_in_bbox(...)` join on first plan.

## One queue

The remaining queue lives in Valkey via BullMQ. Workers run in the `jobs` container (same image as `api`, different CMD — see [infra/Dockerfile.jobs](../../infra/Dockerfile.jobs)).

| Queue                | Trigger               | Persists to  | Idempotent?                           |
| -------------------- | --------------------- | ------------ | ------------------------------------- |
| `walking-precompute` | GPX upload completion | `route_legs` | yes — `upsertMatrixCells` ON CONFLICT |

The queue is fire-and-forget from the upload handler's perspective. Uploads must not block on precompute.

For the landuse-side daily replication, see the separate `landuse-replication` queue scheduled by `LanduseReplicationScheduler` (an M4-β follow-up — not yet built; the write path it will drive lives in [LanduseRepository](../../apps/api/src/osm/landuse.repository.ts)).

## `walking-precompute` algorithm

Job payload: `{ ownerId: string; newCacheIds: number[]; reason: 'upload' | 'retrigger-stale' | 'retrigger-one' }`.

1. **Resolve scope.** Fetch the new caches' locations. Find every existing cache within `PLANNER_PRECOMPUTE_RADIUS_M` (default 4000 m, aligned with the runtime walking-graph cap of `min(maxLinkMeters*2, 4000)`) of any new cache via `ST_DWithin(..., 4000)` — these are the "affected" caches. Then pull in **every sibling stage of any touched Adventure Lab** (`CachesRepository.findAdventureGroupsForCaches`): a single imported/relocated stage drags in its whole adventure, regardless of distance. The in-scope set is `new ∪ affected ∪ adventure-siblings`.

2. **Mark in-scope as `in_progress`** in `cache_precompute_state` (kind='walking'). Single bulk UPSERT.

3. **Fetch haversine neighbours per in-scope cache.** For each in-scope cache, find its top `k_candidates = max(PLANNER_KNN_K*3, PLANNER_KNN_K+5) = 36` nearest neighbours by haversine within `PLANNER_PRECOMPUTE_RADIUS_M` (4 km default) via `<->` ordered PostGIS query. The 36 matches the runtime over-fetch in [walking-graph.ts](../../apps/api/src/tours/strategies/greedy/walking-graph.ts) exactly — no semantic drift.

4. **Force full pairwise within each touched adventure.** k-NN alone never guarantees an Adventure Lab's stages reach each other — adventures are collapsed to one representative for clustering (FR-I17), and in dense areas a stage's siblings fall outside its top-36. So add the **complete directed stage→stage matrix** for every touched adventure (≤ ~90 pairs for 10 stages) on top of the k-NN pairs. This makes "every AL stage has walking edges" an invariant of the import/refresh path and keeps atomic-adventure solver routing (FR-I16) fully cache-warm. Because the relocation invalidation (below) deletes **all** legs touching a moved stage, the same full-pairwise rebuild restores its sibling edges on the re-warm.

5. **De-dupe and chunk pair set.** Convert to a directed `(from, to)` set, de-dupe, sort. Chunk by origin: at most 100 origins per OSRM `/table` call. Each chunk is one HTTP request.

6. **Filter already-fresh pairs.** Drop pairs already in `route_legs` with `osrm_version == current_version`. The remaining set is what we actually call OSRM for.

7. **Call OSRM `/table` per chunk.** Use the existing `OsrmClient.table([origin, ...dests], 'foot')`. For each non-null cell, emit a `route_legs` row with `source='table'`, `geom=NULL`, `osrm_version=current`. Persist via `RoutingRepository.upsertMatrixCells(cells, osrmVersion)` (already chunked at 5k rows internally).

8. **Mark in-scope as `fresh`** in `cache_precompute_state` with current `osrm_version` and `fetched_at = now()`. On any chunk failure, mark only the affected caches as `failed` with `error_text`; the rest succeed independently (chunk-level transactions, not job-level).

9. **Log a one-liner**: how many caches processed, how many pairs fetched, how many were already fresh.

## `landuse-replication` algorithm (ADR-0009)

Replaces the per-upload `overpass-refresh` queue. Runs **daily at 04:00**
host time (BullMQ repeatable job, cron `0 4 * * *`), not per-upload.

Job payload: `{ reason: 'scheduled' | 'manual' }`.

1. **Read `landuse_import_meta`.** If no row exists, log and exit (an
   operator hasn't run `osm2pgsql-import` yet).
2. **12 h minimum-interval guard.** If `replicated_at` (fallback
   `imported_at`) is < 12 h ago AND the trigger was scheduled, skip.
   Manual triggers (from `POST /admin/landuse/reimport`) bypass this gate.
3. **Acquire Postgres advisory lock** (id `909_001`) so concurrent
   triggers serialise. If another holder is present, skip and log.
4. **Record heartbeat.** Update `landuse_import_meta.replication_state`
   with the run reason + timestamp.

The actual `osm2pgsql-replication update` invocation lives in the
`osm2pgsql-import` compose service (which contains the osm2pgsql binary).
A host-side systemd timer in a follow-up will call
`docker compose -p gctp run --rm osm2pgsql-import /srv/bootstrap.sh replicate`
on the same schedule and report success via the same `landuse_import_meta`
row.

## `cache_precompute_state` lifecycle

```
                ┌─────────┐
                │ pending │ ← bulk UPSERT before fan-out
                └────┬────┘
                     ▼
              ┌──────────────┐
              │ in_progress  │ ← chunk pick-up
              └──┬────────┬──┘
                 │        │
            success      failure
                 │        │
                 ▼        ▼
              ┌──────┐ ┌──────┐
              │fresh │ │failed│
              └──────┘ └──────┘
```

Stale-cache definition (one SQL view `v_stale_caches`):

```sql
SELECT cache_id, kind FROM cache_precompute_state
WHERE state IN ('failed', 'pending', 'in_progress')
   OR (kind = 'walking' AND osrm_version <> :current_version)
   OR fetched_at < now() - (:ttl_days || ' days')::interval
UNION ALL
-- caches that have never been precomputed for this kind
SELECT c.id, k.kind
FROM caches c CROSS JOIN unnest(ARRAY['walking','landuse']::precompute_kind[]) AS k(kind)
WHERE NOT EXISTS (
  SELECT 1 FROM cache_precompute_state s
  WHERE s.cache_id = c.id AND s.kind = k.kind
);
```

The TTL default is 30 days for `walking` (matches the existing OSRM refresh expectation). Landuse no longer participates in per-cache precompute state — see ADR-0009.

## Admin API

Gated by the existing dev-user middleware (revisit when M6 ships auth).

- `GET /admin/precompute/summary` — `{ walking: { fresh, stale, failed, in_progress, missing }, landuse: {...} }`.
- `GET /admin/precompute/stale?kind=walking&limit=200` — paginated list of stale `cache_id`s + last `error_text`.
- `POST /admin/precompute/retrigger-stale` — `{ kind: 'walking' | 'landuse' | 'all' }`. Selects stale ids via `v_stale_caches`, chunks at 50/job, enqueues. Returns `{ enqueued, jobIds }`.
- `POST /admin/precompute/retrigger-one` — `{ cacheId, kind }`. Single-cache retry from the failed-list row.
- `GET /admin/precompute/adventure-labs` (FR-I20) — walking-precompute health for Adventure Lab stages only: per-bucket counts + AL total.
- `POST /admin/precompute/adventure-labs/backfill` (FR-I20) — **repair for AL stages missing walking edges.** Unions two detectors so no stage slips through: (1) `cache_precompute_state` freshness (`adventureLabWalkingIdsNeedingPrecompute` — no row / pending / failed / version drift / past TTL) and (2) **incomplete intra-adventure pairwise** at the current `osrm_version` (`RoutingRepository.adventureLabStageIdsWithIncompletePairwise` — a multi-stage adventure with fewer than `k*(k-1)` directed legs among its own stages, counting `noroute` rows as covered; subsumes fully-isolated stages and catches `fresh`-but-incomplete adventures from before the full-pairwise guarantee). Re-warming each flagged stage repairs its whole adventure via the full-pairwise step above. Chunks + enqueues like `retrigger-stale`; returns `{ enqueued, jobIds }`.

## Operator dashboards

- **Bull-Board** at `/admin/queues` — live queue ops (pause/retry/clean).
- **Custom `/admin/jobs` page** in the web app — per-kind summary tiles, "retrigger stale" buttons (with confirm dialog showing the count), failed-list table with per-row retry. Auto-refresh every 5 s via TanStack Query.

## Tunability (env knobs)

All read at job-pickup time, so changes apply on the next job — no rebuild.

| Env                             | Default | Description                                                                                                                                                                                                           |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_KNN_K`                 | `12`    | k for the walking graph. `k_candidates = max(K*3, K+5)` determines haversine over-fetch per cache.                                                                                                                    |
| `PLANNER_PRECOMPUTE_RADIUS_M`   | `4000`  | Haversine cap for the affected-set + neighbour search. Matches the runtime hard cap `min(maxLinkMeters*2, 4000)`. Was 3000 originally; bumped after observing /table fanout in discovery when `maxLinkMeters > 1500`. |
| `LANDUSE_FORCE_REIMPORT`        | _unset_ | Set to `1` and recreate `osm2pgsql-import` to force a full re-import of `landuse_polygons`. See ADR-0009.                                                                                                             |
| `PRECOMPUTE_STALE_TTL_DAYS`     | `30`    | Beyond this, a `fresh` row is considered stale and eligible for re-trigger by `/admin/precompute/retrigger-stale`.                                                                                                    |
| `PRECOMPUTE_OSRM_CHUNK_ORIGINS` | `100`   | Max origins per `/table` call. Higher = fewer HTTP round-trips, larger response payloads.                                                                                                                             |
| `PRECOMPUTE_RETRIGGER_CHUNK`    | `50`    | Caches per retrigger-stale job. Bounds individual job runtime.                                                                                                                                                        |

Symptom → knob:

- **First post-upload `/tours/clusters` is still slow.** Check the `walking` queue depth in `/admin/queues`; the precompute may still be running. If it consistently lags, raise `PRECOMPUTE_OSRM_CHUNK_ORIGINS` so each job does more per HTTP round-trip.
- **Landuse missing in cluster scoring.** Check `GET /admin/landuse/status` — `polygonCount == 0` means `osm2pgsql-import` hasn't completed. Trigger a fresh import with `LANDUSE_FORCE_REIMPORT=1 docker compose -p gctp up osm2pgsql-import`.
- **OSRM extract bumped; clusters look weird.** All `walking` rows are now stale (osrm_version mismatch). `POST /admin/precompute/retrigger-stale {kind:'walking'}` refreshes the whole DB.
