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
| `PLANNER_CLUSTERING` | `hdbscan-star` | Strategy used to partition the walking graph. Alternatives: `louvain`, `leiden`, `dbscan`, `hdbscan`, `components`. **`hdbscan-star`** (true HDBSCAN\*, condensed-tree stability extraction) is the default — it wins the end-to-end cluster-tuning bench on real data (most caches per routed loop, least fringe). `louvain`/`leiden` are community-detection (Leiden guarantees connected communities); `hdbscan` is the legacy recursive-bisection variant kept for A/B; `components` is the baseline. |
| `PLANNER_HDBSCAN_SELECTION` | `eom` | Flat-cluster selection for `hdbscan-star` only. `eom` (Excess of Mass, default) keeps a cluster whole unless its sub-splits are collectively more stable; `leaf` always takes the finest stable sub-clusters (more, smaller clusters). Read once at process start. |
| `PLANNER_KNN_K`      | `12`      | k-NN size per origin in the sparse walking graph. Higher = denser graph, more compute, fewer artificial cluster boundaries; lower = sharper splits, more chance of orphans. |
| `PLANNER_KNN_SYMMETRY` | `or` | How a k-NN edge becomes undirected. `or` (default, legacy): keep the edge if **either** endpoint ranks the other in its top-k. `mutual` ("dual-link"): keep it only if **both** do, with a min-degree floor that re-adds an otherwise-orphaned node's nearest edge(s). Mutual kills one-way "hub" links that fuse distinct pods → sharper cluster separation, at some recall cost in sparse/rural areas (the floor mitigates orphaning). Benefits every clustering strategy; A/B via the explain endpoint. |
| `PLANNER_KNN_MUTUAL_FLOOR` | `1` | Min-degree floor for `mutual` symmetry only. `1` = never orphan a node (re-add its single nearest edge). `2` tops each node up to its two nearest edges, recovering most of the cluster coverage mutual gives up, for a small loss of tightness. Ignored when `PLANNER_KNN_SYMMETRY=or`. |
| `PLANNER_GEO_TRIM_FACTOR` | `2` | Geographic-outlier-trim aggressiveness. The trim drops cluster members beyond `min(median × FACTOR, budget × CAP_FRAC)` from the centroid (iterated to a fixed point), where `median` is the members' median distance to the centroid. **This runs in Pass-1, before routing** — it's the dominant cap on cluster size: raising FACTOR lets clusters extend toward the distance budget and pack more caches (more 13+ clusters) at the cost of more fringe/retrace once routed. Measured sweet spot for a 10 km budget is ~2–3. A very large value disables the relative term, leaving only the absolute budget cap. |
| `PLANNER_GEO_TRIM_CAP_FRAC` | `0.25` | Absolute ceiling for the geographic-outlier-trim as a fraction of `distanceBudgetMeters` (default `budget/4`). Raise (e.g. `0.5`) together with a high `PLANNER_GEO_TRIM_FACTOR` to effectively defer geographic trimming to the route-aware Pass-2 trims. |
| `PLANNER_CLUSTER_GROW` | _unset_ | Boundary-spanning clusters ([ADR-0026](adr/0026-boundary-spanning-clusters.md)). Set `1`/`true` to let a cluster that straddles the search circle grow past it: discovery fetches caches out to `radiusM + distanceBudgetMeters/2`, seeds only from the in-radius subset, and constrains the graph to the pool (closing the `refine→pool invariant broken` leak). Default-off = legacy hard cutoff at `radiusM`. Growth is bounded by the `distanceBudgetMeters` cap and `MAX_DISCOVERY_POOL`. |
| `PLANNER_COLOCATE_M` | `40` | Pass-2 co-location collapse. Caches within this walking distance of each other (most often the stages of one Adventure Lab) merge into a **single routing node** for TSP / trim / parking / per-leg OSRM, then expand back to their member stops on output (contiguous, stage-ordered, with tiny synthesized legs between them). Cuts node count so a 20+-stop cluster plans fast, and removes the near-zero-distance legs that produced weird orderings — the route stays distance-optimal and far-apart stages of an adventure still interleave normally. `0` disables collapsing. |

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
available). After each drop the tour is re-TSP'd and the loop repeats
until stable.

Source: [apps/api/src/tours/strategies/greedy/marginal-trim.ts](../apps/api/src/tours/strategies/greedy/marginal-trim.ts)

**Budget-aware mode is the default.** Rather than cutting every cache whose
detour crosses a fixed metre threshold — which left routed loops ~2 km
short of the distance budget — the trim now routes the _full_ cluster and
only removes a cache when it earns its keep:

- **loop ≤ `distanceBudgetMeters`:** keep normal caches (fill the budget);
  drop only genuine outliers whose marginal exceeds the outlier floor
  `outlierFactor × maxLinkMeters` — a cache stuck behind a single-bridge
  barrier, not merely on the fringe.
- **loop > budget:** iteratively drop the worst-marginal cache (the one
  whose removal shortens the loop most) and re-2-opt until the loop fits.

The legacy fixed-threshold cutter (`thresholdMeters = maxLinkMeters`) is
kept behind `PLANNER_MARGINAL_BUDGET_AWARE=false`.

| Env                              | Default | What it does                                                                                                                                                                                  |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANNER_MARGINAL_BUDGET_AWARE`  | `true`  | Budget-aware trim (above). Set to `false` to fall back to the legacy fixed-threshold trim: drop any cache whose marginal exceeds `maxLinkMeters`, regardless of how far the loop is from full. |
| `PLANNER_MARGINAL_OUTLIER_FACTOR` | `2.0`   | Outlier floor as a multiple of `maxLinkMeters` (default ⇒ 3 km at the 1.5 km link cap). In budget-aware mode, a within-budget loop only loses caches whose detour exceeds this. Raise to keep more borderline caches; lower to prune fringe more aggressively. |

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
| One outlier cache forces a 2 km+ detour (loop within budget)                 | Outlier floor too high to catch it                                                | Lower `PLANNER_MARGINAL_OUTLIER_FACTOR` (e.g. `1.5`) so within-budget outliers get pruned sooner                             |
| Loop ends ~2 km short of `distanceBudgetMeters` with caches left on the map  | Marginal trim cut caches before the budget filled                                 | Confirm `PLANNER_MARGINAL_BUDGET_AWARE=true` (default); raise `PLANNER_MARGINAL_OUTLIER_FACTOR` to keep more borderline caches |
| Tour over `distanceBudgetMeters` after routing                               | Cluster's irreducible loop exceeds the budget                                     | The budget-aware trim already drops worst-marginal caches to fit; if it can't (all detours near zero), pick a smaller cluster or raise the budget |
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
- **Solver loop-shape is lexicographic, not single-objective**
  ([infra/solver/](../infra/solver/)). The solver now optimises loop length
  (a SOFT per-metre penalty) **below** the visited-count reward (MEDIUM), so it
  never sacrifices a cache to shorten the loop — it only compacts among
  equal-count solutions. Street-level retrace minimisation still happens in the
  shared post-solve loop-aware leg picker (same as greedy), not inside the
  solver. Landuse/terrain soft preferences remain deferred (post-M5).
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

## Strategy selection (`TOUR_PLANNER`) — FR-I16

Pass-2 routing picks a planner **per request**:

| Env            | Default | What it does                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOUR_PLANNER` | `auto`  | `auto`: route to the Timefold **solver** when the candidate set contains an Adventure Lab stage (it models atomic adventures + contiguity + loop shape), otherwise use the fast **greedy** planner. `greedy`: force greedy for every plan. `solver`: force the solver for every plan. A solver outage/timeout falls back to greedy for that plan. |
| `PLANNER_SOLVER_LOOP_WEIGHT` | `1` | SOFT per-metre loop-length penalty sent to the solver. Lives **below** the visited-count reward (MEDIUM), so it only compacts the loop among equal-count solutions — it never drops a cache. `0` disables loop-shape compaction (revert to "any order within budget"). |

Two **per-tour** toggles (set in the tour-settings panel, both default **on**) shape the solver path:

- **`completeAdventuresOnly`** — include an Adventure Lab whole or not at all. The solver enforces atomicity (HARD); the missing stages of any selected adventure are pulled in from the DB beforehand, and the AL-aware post-solve trim never orphans an adventure.
- **`adventureInterleave`** — when **off**, an adventure's stages must form one contiguous block in the visit order (HARD contiguity); when on, they may interleave with other caches for the shortest route.

**Linear adventures** (FR-I18) need no toggle: a *linear* Adventure Lab (Lab2Gpx `linear: "mark"` → `[L]` prefix → `adventure_sequential`) is routed in ascending `stageSequence` order via a HARD ordering constraint, applied only to adventures flagged linear and orthogonal to `adventureInterleave`. Like atomicity, ordering is **solver-only** — a forced `TOUR_PLANNER=greedy` won't reorder linear stages (`auto` always routes AL sets to the solver). A separate **discovery** toggle, `includeAdventuresInClustering` (default on, FR-T15), decides whether Adventure Labs take part in Pass-1 cluster forming at all.

Co-located AL stages collapse into one routing node before solving (`PLANNER_COLOCATE_M`) and expand back on output, exactly as in the greedy path.
