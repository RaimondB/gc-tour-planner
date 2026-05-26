# Precompute — walking paths + landuse on upload

Background jobs that fire on GPX upload completion and warm the caches the route planner reads at request time. Rationale: [ADR-0007](../adr/0007-precompute-walking-paths-on-upload.md). User-facing requirement: [requirements/ingest.md FR-I8](../requirements/ingest.md).

## Two queues

Both queues live in Valkey via BullMQ. Workers run in the `jobs` container (same image as `api`, different CMD — see [infra/Dockerfile.jobs](../../infra/Dockerfile.jobs)).

| Queue                | Trigger                          | Persists to       | Idempotent? |
| -------------------- | -------------------------------- | ----------------- | ----------- |
| `walking-precompute` | GPX upload completion            | `route_legs`      | yes — `upsertMatrixCells` ON CONFLICT |
| `overpass-refresh`   | GPX upload completion + on-demand from `OsmService` cache miss | `osm_landuse`    | yes — `replaceCell` per area_hash |

Both queues are fire-and-forget from the upload handler's perspective. Uploads must not block on precompute.

## `walking-precompute` algorithm

Job payload: `{ ownerId: string; newCacheIds: number[]; reason: 'upload' | 'retrigger-stale' | 'retrigger-one' }`.

1. **Resolve scope.** Fetch the new caches' locations. Find every existing cache within `PLANNER_PRECOMPUTE_RADIUS_M` (default 3000 m) of any new cache via `ST_DWithin(..., 3000)` — these are the "affected" caches. The in-scope set is `new ∪ affected`.

2. **Mark in-scope as `in_progress`** in `cache_precompute_state` (kind='walking'). Single bulk UPSERT.

3. **Fetch haversine neighbours per in-scope cache.** For each in-scope cache, find its top `k_candidates = max(PLANNER_KNN_K*3, PLANNER_KNN_K+5) = 36` nearest neighbours by haversine within 3 km via `<->` ordered PostGIS query. The 36 matches the runtime over-fetch in [walking-graph.ts](../../apps/api/src/tours/strategies/greedy/walking-graph.ts) exactly — no semantic drift.

4. **De-dupe and chunk pair set.** Convert to a directed `(from, to)` set, de-dupe, sort. Chunk by origin: at most 100 origins per OSRM `/table` call. Each chunk is one HTTP request.

5. **Filter already-fresh pairs.** Drop pairs already in `route_legs` with `osrm_version == current_version`. The remaining set is what we actually call OSRM for.

6. **Call OSRM `/table` per chunk.** Use the existing `OsrmClient.table([origin, ...dests], 'foot')`. For each non-null cell, emit a `route_legs` row with `source='table'`, `geom=NULL`, `osrm_version=current`. Persist via `RoutingRepository.upsertMatrixCells(cells, osrmVersion)` (already chunked at 5k rows internally).

7. **Mark in-scope as `fresh`** in `cache_precompute_state` with current `osrm_version` and `fetched_at = now()`. On any chunk failure, mark only the affected caches as `failed` with `error_text`; the rest succeed independently (chunk-level transactions, not job-level).

8. **Log a one-liner**: how many caches processed, how many pairs fetched, how many were already fresh.

## `overpass-refresh` algorithm

Job payload: `{ ownerId: string; newCacheIds: number[]; reason: 'upload' | 'retrigger-stale' | 'retrigger-one' }`.

1. **Compute bbox** of `newCacheIds` (PostGIS `ST_Extent`); buffer by 500 m via `ST_Buffer(..., 500)`.
2. **Snap bbox to cells** via the existing `OsmService.cellsForBbox` (0.1° per cell).
3. For each cell: if newest `osm_landuse` row in cell is fresher than `OVERPASS_REFRESH_TTL_HOURS` (default 168 = 7 days), skip — already fresh. Otherwise `OsmService.refreshCell(cell)` (existing in-flight dedup).
4. **Mark in-scope caches as `fresh`** in `cache_precompute_state` (kind='landuse'). Landuse has no OSRM version equivalent, so `osrm_version` is NULL for landuse rows.

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

The TTL default is 30 days for `walking` (matches the existing OSRM refresh expectation) and the `OVERPASS_REFRESH_TTL_HOURS` window for `landuse`.

## Admin API

Gated by the existing dev-user middleware (revisit when M6 ships auth).

- `GET /admin/precompute/summary` — `{ walking: { fresh, stale, failed, in_progress, missing }, landuse: {...} }`.
- `GET /admin/precompute/stale?kind=walking&limit=200` — paginated list of stale `cache_id`s + last `error_text`.
- `POST /admin/precompute/retrigger-stale` — `{ kind: 'walking' | 'landuse' | 'all' }`. Selects stale ids via `v_stale_caches`, chunks at 50/job, enqueues. Returns `{ enqueued, jobIds }`.
- `POST /admin/precompute/retrigger-one` — `{ cacheId, kind }`. Single-cache retry from the failed-list row.

## Operator dashboards

- **Bull-Board** at `/admin/queues` — live queue ops (pause/retry/clean).
- **Custom `/admin/jobs` page** in the web app — per-kind summary tiles, "retrigger stale" buttons (with confirm dialog showing the count), failed-list table with per-row retry. Auto-refresh every 5 s via TanStack Query.

## Tunability (env knobs)

All read at job-pickup time, so changes apply on the next job — no rebuild.

| Env                              | Default | Description                                                                                                  |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `PLANNER_KNN_K`                  | `12`    | k for the walking graph. `k_candidates = max(K*3, K+5)` determines haversine over-fetch per cache.            |
| `PLANNER_PRECOMPUTE_RADIUS_M`    | `3000`  | Haversine cap for the affected-set + neighbour search. Matches the runtime `min(maxLinkMeters*2, 4000)` default. |
| `OVERPASS_REFRESH_TTL_HOURS`     | `168`   | Serve-stale window for landuse. Cells fresher than this are skipped by `overpass-refresh`.                    |
| `PRECOMPUTE_STALE_TTL_DAYS`      | `30`    | Beyond this, a `fresh` row is considered stale and eligible for re-trigger by `/admin/precompute/retrigger-stale`. |
| `PRECOMPUTE_OSRM_CHUNK_ORIGINS`  | `100`   | Max origins per `/table` call. Higher = fewer HTTP round-trips, larger response payloads.                    |
| `PRECOMPUTE_RETRIGGER_CHUNK`     | `50`    | Caches per retrigger-stale job. Bounds individual job runtime.                                               |

Symptom → knob:

- **First post-upload `/tours/clusters` is still slow.** Check the `walking` queue depth in `/admin/queues`; the precompute may still be running. If it consistently lags, raise `PRECOMPUTE_OSRM_CHUNK_ORIGINS` so each job does more per HTTP round-trip.
- **Landuse missing in cluster scoring.** Check the `landuse` summary tile; if there's drift, `POST /admin/precompute/retrigger-stale {kind:'landuse'}`.
- **OSRM extract bumped; clusters look weird.** All `walking` rows are now stale (osrm_version mismatch). `POST /admin/precompute/retrigger-stale {kind:'walking'}` refreshes the whole DB.
