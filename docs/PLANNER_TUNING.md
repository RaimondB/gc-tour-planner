# Planner tuning

Operator's guide to the route-planning knobs. Every lever here is an env
var read at request time, so changes apply on the next plan call without
a rebuild. Defaults are listed alongside; values in `infra/docker-compose.yml`
override `apps/api/.env` overrides built-in defaults.

> Cross-references: [docs/design/tour-planning.md](design/tour-planning.md)
> for the full Pass 1 / Pass 2 algorithm; the per-feature source files
> linked under each section for the actual implementations.

## The two-pass model

Pass 1 — **cluster discovery**. Pulls every cache matching the search
filters within `radiusM` (capped at 2000 candidates), builds a sparse
walking graph (k-NN over OSRM `/table`), runs the chosen clustering
strategy, applies a refinement pipeline (MST-cut → walking-outlier-trim
→ geographic-outlier-trim → Jaccard-dedup), scores the results, and
returns the top-5 candidate clusters.

Pass 2 — **routed loop**. Takes a user-picked cluster, fetches its
distance matrix (cache-aware via `route_legs`), runs NN+2-opt for the
TSP order, applies the **marginal-cost trim** (drops caches whose
inclusion adds more walking than they're worth), then assembles the
polyline leg-by-leg via OSRM `/route` with the **loop-aware leg picker**
(plus the via-waypoint nudge fallback when OSRM offers no real
alternative).

Everything below tunes one of those steps.

## Pass 1 — cluster discovery

| Env                  | Default   | What it does                                                                                                                                                                |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_CLUSTERING` | `louvain` | Strategy used to partition the walking graph. Alternatives: `dbscan`, `hdbscan`, `components`. Louvain has produced the most visibly-sensible clusters in field testing.    |
| `PLANNER_KNN_K`      | `12`      | k-NN size per origin in the sparse walking graph. Higher = denser graph, more compute, fewer artificial cluster boundaries; lower = sharper splits, more chance of orphans. |

## Pass 2 — OSRM extract version tag

| Env                 | Default                       | What it does                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OSRM_VERSION_FILE` | `/osrm-meta/osrm-version.txt` | Path the api reads to determine the live OSRM extract's identity. Written by `infra/osrm/bootstrap.sh` after every `osrm-customize`. Rows in `route_legs` whose `osrm_version` column doesn't match are filtered out on read — a one-time re-fetch into the live namespace happens automatically. Falls back to `'unknown'` when the file is missing. |

## Pass 2 — loop-aware leg picker

Stops the tour from walking the same main street twice. Each leg's
polyline is scored against an `OverlapGrid` of already-walked
coordinates; alternatives with less overlap win the score even when
they're a bit longer.

Source: [apps/api/src/tours/strategies/greedy/loop-aware-legs.ts](../apps/api/src/tours/strategies/greedy/loop-aware-legs.ts)

| Env                       | Default | What it does                                                                                                                                                                                                                                       |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_LOOP_ALPHA`      | `1.0`   | Weight on overlap in the score: `meters + α × overlap_meters`. `α=1` means "1 m of retraced street is as costly as 1 m of detour". Raise to fight retracing harder; set to `0` to disable loop preference entirely (revert to plain shortest-leg). |
| `PLANNER_LOOP_GRID_M`     | `25`    | Spatial-grid cell size for overlap detection. Coarser = more lenient (fewer false-positive overlaps); finer = stricter. 25 m matches OSM road-segment granularity.                                                                                 |
| `PLANNER_LOOP_MAX_DETOUR` | `0.5`   | Hard cap on how much longer a chosen alternative may be vs. primary, as a fraction. `0.5` = up to 50 % longer. Safety valve for dead-end streets.                                                                                                  |
| `PLANNER_LOOP_ALT_COUNT`  | `2`     | Extra alternatives requested from OSRM beyond the primary (clamped 0..5). OSRM's MLD algorithm often returns 0-1 useful alts on short urban foot legs — that's where the nudge fallback kicks in.                                                  |

## Pass 2 — via-waypoint nudge

Fallback for when OSRM's own alternative-finder produces nothing useful
(very common on short urban foot legs). When the picked leg's overlap
fraction exceeds the nudge threshold, the planner asks OSRM to route
through a perpendicular-offset midpoint of the leg — OSRM snaps the via
to the nearest walkable node, so a real parallel street wins; no
parallel street, no harm done (snaps back).

| Env                              | Default  | What it does                                                                                                                                                                                                                                                                |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_LOOP_NUDGE_THRESHOLD`   | `0.3`    | Overlap-fraction trigger. When at least 30 % of the picked leg's coords land on already-walked grid cells, try the nudge. `1` disables the nudge fallback entirely.                                                                                                         |
| `PLANNER_LOOP_NUDGE_OFFSETS_M`   | `80,160` | Comma-separated perpendicular offset distances tried on each side. 80 m typically lands on a parallel village street; 160 m on a suburban grid; both are tried so we cover a range of geometries.                                                                           |
| `PLANNER_LOOP_NUDGE_FRACTIONS`   | `0.5`    | Comma-separated positions along the leg at which to anchor the via-waypoint (0..1). `0.5` = midpoint only. `0.33,0.5,0.67` triples the OSRM call count but covers leg-start, middle and leg-end variants — turn on when midpoint nudges keep landing on the same main road. |
| `PLANNER_LOOP_SEVERE_OVERLAP`    | `0.5`    | When the primary's overlap fraction crosses this threshold, the detour cap (`max-detour`) is replaced with the severe variant below — a primary that retraces > 50 % of itself deserves to be replaced even by a substantially-longer loop.                                 |
| `PLANNER_LOOP_SEVERE_MAX_DETOUR` | `1.5`    | Detour cap used in severe-overlap mode. `1.5` = an alt up to 2.5× the primary's length may win the score if its overlap savings warrant it.                                                                                                                                 |

## Pass 2 — marginal-cost trim

Drops caches whose inclusion adds more walking than they're worth.
Computed as `d(prev, k) + d(k, next) − d(prev, next)` for every position
in the tour (including the parking endpoints when parking distances are
available). Anything above the threshold gets removed, the tour is
re-TSP'd, and the loop repeats until stable.

Source: [apps/api/src/tours/strategies/greedy/marginal-trim.ts](../apps/api/src/tours/strategies/greedy/marginal-trim.ts)

The threshold is computed as:

```
threshold = min(hardMaxM, max(absoluteFloorM, ratio × medianWalking))
```

| Env                                | Default | What it does                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_MARGINAL_DROP_ENABLED`    | `true`  | Set to `false` to skip the trim entirely.                                                                                                                                                                                                                                                                              |
| `PLANNER_MARGINAL_DROP_RATIO`      | `2.0`   | Multiplier on the cluster's own median walking distance. Higher = more permissive (only catch wildly-bad caches); lower = aggressive.                                                                                                                                                                                  |
| `PLANNER_MARGINAL_DROP_ABS_M`      | `500`   | Absolute floor on the threshold. Even on tiny dense clusters, a cache has to add at least this much extra walking to be considered marginal.                                                                                                                                                                           |
| `PLANNER_MARGINAL_DROP_HARD_MAX_M` | `3000`  | **Hard ceiling on the threshold**. Without it, "poisoned" clusters where most pairs already cross a barrier (a river archipelago, say) end up with a 20 km+ median and the trim becomes a no-op. With the cap in place, any cache adding > 3 km is always trimmed regardless of how distorted the cluster's median is. |

Dropped caches surface in the `PlanResult.droppedCacheIds` field and
get a gray-x marker on the map so the user can see they were trimmed
deliberately, not just absent from the cluster.

## Pass 2 — Automatic start (default)

`startPreference="auto"` is the default. It tries each source in turn —
**`parking-waypoint` → `osm-parking` → `osrm-nearest-road`** — and uses the
**first** that yields a feasible start (one reachable within `maxLinkMeters`).
Auto reuses the OSM access/fee defaults (`["yes", "customers"]` / `"any"`); the
sidebar only exposes those chips for the explicit `osm-parking` mode, so Auto is
zero-config. When every source comes up empty the planner starts at the cluster
centroid and sets `ParkingChoice.fallback = true` — the web client then renders
a distinct red **"P?"** marker instead of the usual blue **"P"**, so "no parking
found within range" is visible without a separate banner. The same `fallback`
flag is set whenever an explicit single mode finds nothing reachable.

## Pass 2 — OSM parking start (ADR-0011)

When `startPreference="osm-parking"` is selected, the planner picks a
tour start from the `parking_facilities` table populated by osm2pgsql.
Two per-request knobs live on `PlanInput` / `PlanLoopInput`, surfaced
in the sidebar:

| Field                    | Default                | Effect                                                                                                                                                                       |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `osmParkingAccessFilter` | `["yes", "customers"]` | OSM `access` values eligible as tour starts. `permit` is opt-in (a permit you don't have ≈ private). `private`/`no` are never offered.                                       |
| `osmParkingFeeFilter`    | `"any"`                | `"free"` requires `fee=no`; `"paid"` requires `fee=yes`; `"any"` allows both. `parking:condition=disc` (NL blue zones) is normalised to `fee=no` upstream by the Lua import. |

Selection is **loop-aware**: every candidate within `maxLinkMeters` is
scored by its cheapest insertion edge into the planned loop
(`parking→next + prev→parking − prev→next`) and the lowest-detour one
wins — the lot that adds the least walking to the _tour_, not merely the
one closest to a single cache. Candidates whose nearest-cache walk exceeds
the cap (usually an OSM data gap, e.g. a missing footway connector) are
dropped; the planner falls back to OSRM-nearest-road if none survive. The
chosen `ParkingChoice.reason` includes the OSM id, access, fee, and the
detour it added. (PQ `parking-waypoint` selection uses the same loop-aware
scorer.)

## Pass 2 — car-accessible nearest-road start (ADR-0012)

When `startPreference="osrm-nearest-road"` is selected, the planner snaps
parking onto quiet, **car-accessible** roads from the `car_roads` table
(not the foot graph) and scores the candidates loop-aware, exactly like
OSM/PQ parking. Eligible roads: `highway ∈ {residential, living_street,
unclassified, service, tertiary}` (coarse filter in the osm2pgsql Lua),
minus `access`/`motor_vehicle ∈ {no, private}`, `maxspeed ≥ 70`, and
`service = driveway` (fine filter at query time — retunable without a
re-import). If no eligible road is reachable, it falls back to the old
OSRM `/nearest` foot-snap of the centroid.

| Knob                      | Default | Effect                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_ROAD_CANDIDATES` | `12`    | Number of eligible road segments enumerated as parking candidates — the ones closest to the **tour path** (the closed cycle line, not the centroid), clamped 1..50. Each becomes one `ST_ClosestPoint` snap point fed to the loop-aware scorer's batched OSRM `/table`. Higher = more thorough placement at the cost of a larger `/table`; lower = cheaper, coarser. |

## Compute worker pool (ADR-0014)

The planner's CPU-heavy pure computations — the TSP solver (`solveTwoOpt`, used
by `planLoop` + the marginal/fringe re-solves) and the whole cluster-discovery
pipeline (Louvain + refine + score) — run in a **piscina worker-thread pool**, not
on the API event loop. This keeps the API responsive to other users while one
request crunches; only serializable pure functions cross the boundary (all OSRM

- Postgres I/O stays on the main thread).

| Knob                        | Default                      | Effect                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_WORKER_THREADS`    | `max(1, cpus-1)` capped at 4 | Pool size — how many planner CPU tasks run in parallel across cores. Raise for more concurrent planning throughput on a bigger box; the default leaves a core for the event loop + OSRM (the host is 4C/8T and OSRM already uses ~4). Clamped 1..16. |
| `PLANNER_WORKER_TIMEOUT_MS` | `30000`                      | Per-task abort budget. A task exceeding it is aborted (surfaced as an error) so a pathological input can't tie up a worker. The TSP VND cap still bounds a single solve; this is the outer safety net.                                               |

## Symptom → knob

| Symptom                                                                      | Probable cause                                                                    | Adjust                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Route walks the same street twice through a dense village                    | Loop-aware picker found no useful OSRM alts; nudge didn't land on a parallel road | Raise `PLANNER_LOOP_NUDGE_FRACTIONS` to `0.33,0.5,0.67`; add more offsets like `60,120,200`                                   |
| Loop is "fine" but the planner keeps the primary on heavily-overlapping legs | Alpha too low, or detour cap too tight                                            | Raise `PLANNER_LOOP_ALPHA` to `2.0`; or raise `PLANNER_LOOP_MAX_DETOUR` to `0.75`                                             |
| One outlier cache forces a 2 km+ detour                                      | Marginal trim didn't fire                                                         | Lower `PLANNER_MARGINAL_DROP_RATIO` to `1.5`; or lower `PLANNER_MARGINAL_DROP_ABS_M` to `300`                                 |
| Multiple caches behind the same barrier all stayed                           | Trim threshold inflated by the cluster's own median                               | `PLANNER_MARGINAL_DROP_HARD_MAX_M` is already at 3 km — for an extreme case (river archipelago) lower it further, e.g. `2000` |
| Tour over `distanceBudgetMeters` after routing                               | Pass 2 didn't trim to fit budget (not yet implemented as auto policy)             | Either pick a smaller cluster, raise the budget, or lower the marginal-drop threshold so more caches get trimmed              |
| Loops disabled / want pure shortest tour                                     | —                                                                                 | Set `PLANNER_LOOP_ALPHA=0` and `PLANNER_LOOP_NUDGE_THRESHOLD=1`                                                               |
| Want to verify trim is firing                                                | —                                                                                 | Watch the api logs for `marginal trim: dropped N cache(s)`                                                                    |
| Want to verify loop-aware picker is firing                                   | —                                                                                 | Watch for `leg N: got M alt(s); picked alt #...` lines                                                                        |

## Known limitations

These cases are not yet handled automatically and may need manual
re-clustering or knob tweaks:

- **Cluster spans multiple landmasses separated by sparse foot
  crossings** (river archipelago). The hard-max cap on the trim handles
  this if every "wrong-side" cache adds at least 3 km marginal — but
  visible only after Pass 2 runs. A Pass 1 detour-outlier-trim is the
  proper structural fix; tracked as a follow-up.
- **Endpoint trim depends on parking distances**. Both `GreedyTspPlanner`
  and `SolverTourPlanner` now fetch them, but only after the initial
  TSP — so the first iteration sees endpoints correctly. If a later
  iteration produces a new endpoint, that endpoint is also evaluated
  (parking arrays cover every cache).
- **Solver doesn't yet minimize tour length** ([infra/solver/](../infra/solver/)).
  Its only soft constraint is `visitedCount`. The greedy NN+2-opt
  planner is currently better for distance optimization; the solver
  becomes the right tool once landuse/terrain soft preferences land
  (planned post-M5).
- **`/route?alternatives` rarely returns variants on dense urban foot
  legs** — that's structural in OSRM-MLD. The via-waypoint nudge
  compensates but won't find a parallel street that doesn't exist.

## Upload-triggered precompute (M4-β)

Background jobs that warm `route_legs` and `osm_landuse` so the next
Pass-1 cluster discovery reads from cache rather than waiting on OSRM.
Full algorithm: [design/precompute.md](design/precompute.md). Operator
dashboards: the `/admin/jobs` panel in the web app (per-cache freshness,
retrigger-stale) and bull-board at `/admin/queues` (queue-level ops).

| Env                             | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_PRECOMPUTE_RADIUS_M`   | `4000`  | Haversine cap for the affected-set scan + per-cache k-NN over-fetch. Matches the runtime walking-graph hard cap `min(maxLinkMeters*2, 4000)` so precompute and runtime agree on which pairs exist for any user choice of `maxLinkMeters ≤ 2000`. Bumped from `3000` after observing /table fanout in cluster discovery when `maxLinkMeters > 1500` — at the cost of a ~1.8× larger precompute fanout per upload. |
| `PRECOMPUTE_OSRM_CHUNK_ORIGINS` | `100`   | Max OSRM `/table` origins per HTTP call. Higher = fewer round-trips, larger response payloads. Lower if OSRM CPU spikes.                                                                                                                                                                                                                                                                                         |
| `PRECOMPUTE_STALE_TTL_DAYS`     | `30`    | Beyond this, a `state='fresh'` `cache_precompute_state` row is considered stale and eligible for retrigger-stale.                                                                                                                                                                                                                                                                                                |
| `PRECOMPUTE_RETRIGGER_CHUNK`    | `50`    | Caches per retrigger-stale job. Bounds individual job runtime so the dashboard updates promptly during a sweep.                                                                                                                                                                                                                                                                                                  |
| `LANDUSE_FORCE_REIMPORT`        | _unset_ | Set to `1` and recreate the `osm2pgsql-import` service to force a full re-import (drops & repopulates `landuse_polygons`). Default is to short-circuit on the existing `landuse_import_meta` row (~2 s no-op). See ADR-0009.                                                                                                                                                                                     |
| `OSM2PGSQL_CACHE`               | `256`   | MB of RAM osm2pgsql holds for node-id → location lookups during import. Bumping to `1024` trades ~+800 MB peak RSS for ~25-40% faster import. Disk I/O is the current bottleneck on slim-mode imports; this is the highest-impact knob.                                                                                                                                                                          |
| `OSM2PGSQL_PROCESSES`           | `4`     | Parallel worker count. host is 4C/8T; default uses physical cores. Setting `8` uses hyperthreads for ~10-15% extra speed. No RAM cost worth worrying about.                                                                                                                                                                                                                                                      |
| `OSM2PGSQL_EXTRA`               | _unset_ | Free-form extra flags passed to `osm2pgsql`. Example for the fastest one-shot import (drops `--slim` → ~3× faster but ~5-6 GB peak RAM and loses `osm2pgsql-replication` support): `OSM2PGSQL_EXTRA="--cache 4096"` + manually edit `infra/osm2pgsql/bootstrap.sh` to drop `--slim --drop`. Rare; only useful before a permanent region change.                                                                  |

Symptom → knob:

- **First post-upload `/tours/clusters` is still slow.** Check the queue depth at `/admin/queues`; the precompute may still be running. If it consistently lags, raise `PRECOMPUTE_OSRM_CHUNK_ORIGINS` so each job does more per HTTP round-trip.
- **Landuse missing from cluster scoring.** Check the `landuse` summary tile at `/admin/jobs`; if there's drift, click "Retrigger stale".
- **OSRM extract bumped; clusters look wrong.** All `walking` rows are now stale (osrm_version mismatch). Click "Retrigger stale" for the walking kind — the whole DB re-warms in the background while the planner stays responsive.

## Default applied to UAT

The shipping `infra/.env` sets `TOUR_PLANNER=greedy`. The solver
sidecar still runs (for the docker-compose dependency graph) but is
unused. Switch with:

```
TOUR_PLANNER=solver
```

…after the next solver-side work lands (visitedCount + tour-length
weights).
