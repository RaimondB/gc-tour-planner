# Tour planning algorithm — `GreedyTspPlanner`

MVP strategy, lives at `apps/api/src/tours/strategies/greedy/`. Pure TypeScript. Operator tuning knobs: [../PLANNER_TUNING.md](../PLANNER_TUNING.md).

## Pass 1 — cluster discovery

1. Spatial query: caches in `(center, radiusM)` satisfying `hardFilters` (PostGIS).
   - **Boundary-spanning (ADR-0026, `PLANNER_CLUSTER_GROW`, default-off):** fetch out to `radiusM + distanceBudgetMeters/2` instead, seed clusters only from the in-radius subset, and constrain the walking graph to the pool. A cluster that straddles the search circle is then fully detected rather than truncated at the boundary; growth stays bounded by the distance budget and `MAX_DISCOVERY_POOL`. Off ⇒ legacy hard cutoff at `radiusM`.
   - **k-NN symmetry (`PLANNER_KNN_SYMMETRY`, default `or`):** the sparse walking graph keeps a directed k-NN edge as undirected when **either** endpoint ranks the other (`or`, legacy) or only when **both** do (`mutual`/"dual-link", with a min-degree floor so no node is orphaned). Mutual removes one-way hub links that fuse distinct pods, sharpening separation for every clustering strategy at some recall cost in sparse areas. Edge distance is `MIN(forward, reverse)` either way.
2. Project each cache to **local equirectangular meters** around `center` (cheap; accurate over our radius).
3. **Cluster discovery** via a pluggable strategy (`ClusteringStrategy`, selected by `PlanInput.clusteringStrategy` / `PLANNER_CLUSTERING`, default `hdbscan-star`). All strategies consume the same sparse OSRM walking graph and feed the same refinement pipeline (mst-cut, walking/geographic outlier trim, Jaccard dedup); they differ only in how they propose raw clusters. `hdbscan-star` is the default because it wins the end-to-end cluster-tuning bench (most caches per routed loop, least fringe). Registered strategies:
   - `louvain` — community detection on the exp-weighted graph across a resolution sweep.
   - `leiden` — Louvain + a refinement phase (sub-communities merge only along edges) so every returned community is **internally connected**, fixing Louvain's disconnected-community defect. Same weighted graph / resolution sweep / seed / Jaccard dedup as `louvain`; hand-rolled detector in `clustering/leiden-detect.ts` (no third-party dependency).
   - `dbscan` — density clustering with `ε = maxLinkMeters`.
   - `hdbscan` — robust-single-linkage core + recursive MST bisection (NOT full HDBSCAN; over-splits loose pods).
   - `hdbscan-star` (**default**) — **true HDBSCAN\***: core distance + mutual reachability → single-linkage dendrogram → condense by `minClusterSize` → per-cluster stability (`λ = 1/mreach-distance`) → flat selection by Excess of Mass (`PLANNER_HDBSCAN_SELECTION`, default `eom`). Keeps a loosely-spaced-but-real pod whole when it is more stable than its sub-splits. Operates over the sparse-graph *forest*: each connected component is a selectable cluster (so a uniform pod surfaces as one cluster instead of dissolving to noise), and caches with too few neighbours fall out as noise. Pure module in `clustering/hdbscan-tree.ts`. Skips `walking-outlier-trim` (its noise handling subsumes it); keeps `mst-cut` (the only stage enforcing the distance budget).
   - `components` — connected components on the capped graph (baseline).
4. For each cluster, score:
   ```
   score = clusterDensity * w_density
         + parkingPresence * w_parking
         + softConstraintScore * w_soft
         + budgetFit * w_budget
   ```
   - `clusterDensity` = `count * 100 / MST_length_m` (caches per 100 m of MST — rescaled from raw caches/m so the term lands in roughly the same 0..1+ range as the other scoring axes; previously contributed ~0 and never moved the ranking).
   - `parkingPresence` = 1 if at least one cache in cluster has a `type='parking'` waypoint within 500 m, else 0.
   - `softConstraintScore` = sum of landuse + attribute + terrain/difficulty contributions across the cluster.
   - `budgetFit` = `exp(-((MST_length_m - distanceBudgetMeters) / distanceBudgetMeters)^2)` — Gaussian penalty for clusters too small or too large for the loop budget.
5. Return top **N** clusters. `N = input.topNClusters` (sidebar slider, default 5, max 20). User picks; or the API auto-picks the top one if `autoPick=true`. Was a hardcoded constant; lifted to a per-request knob so a large search area can surface more alternatives without redeploys.

### Landuse profile resolution (M5-β)

`softPreferences.landuseProfileId` (UUID) is resolved by `LanduseProfilesRepository.findById(ownerId, profileId)` — the call applies the system-or-own filter, so cross-tenant id guessing silently returns nothing instead of leaking another user's profile. The repository returns the JSONB `kinds` array directly; the scoring pass passes it as `preferredLanduseKinds` to `scoreCluster`, where `landuseMatch = fraction-of-cluster-caches-with-cache_landuse-row-in-preferred-kinds × landuseWeight`. When the id is unknown or unset, `kinds = []`, `landuseMatch = 0`, and the term contributes nothing. Three seeded system profiles (Forest-heavy, Urban, Balanced) ship with the migration; per-user profile create/delete is a follow-up.

## Pass 2 — refined loop

1. Greedy admission: take the top-scoring cluster, sort its caches by `softScore` desc, admit one by one as long as:
   - `count <= MAX_LOOP_CACHES` (50 — a fixed TSP/matrix safety cap, not a user budget; the planner packs **as many caches as fit the distance budget**, capped here only to bound 2-opt/OSRM cost),
   - **running TSP lower bound** (MST length × 2) ≤ `distanceBudgetMeters`,
   - estimated time ≤ `timeBudgetMinutes` (if set), using `routing.getMatrix` averages.
2. Build the OD distance matrix via `routing.getMatrix(admittedIds)` — **walking distance**, symmetric, memoized per cache pair.
3. **TSP loop solver**: Nearest-Neighbor seed, then **2-opt** until no improving swap. Deterministic tie-breaks (lowest cache id wins). Lives in `packages/shared/src/tsp/two-opt.ts`. The seed is anchored on the cache nearest the **cluster centroid** — a parking-independent choice — so the cache cycle is built _before_ parking is selected and can be scored against it (steps 5–6). The pinned start only chooses which 2-opt local optimum we land in; the actual parking attach point comes from step 6.
4. **Pre-trim** — drop caches whose OSRM-primary marginal `(leg_in + leg_out − skip)` exceeds `input.maxLinkMeters`. Cheap; runs before any leg picking. Threshold migrated from the env-derived `resolveMarginalTrimThreshold` formula to the per-plan `maxLinkMeters` knob so both Pass-1 and Pass-2 trim respect the same user tolerance.
5. **Parking selection** by `startPreference` (`selectParking` in `greedy-tsp-planner.ts`). Each source is a small private helper (`tryPqParking` / `tryOsmParking` / `tryCarRoadParking`) that enumerates candidates and returns the loop-aware pick, or `null` when nothing is reachable. Single-candidate modes resolve directly; multi-candidate modes are **loop-aware** — every candidate is scored by its cheapest insertion edge into the step-3 cycle (`bestParkingInsertion` — the same metric step 6 uses) and the **minimum-detour** candidate wins, i.e. the lot that adds the least walking to the _whole tour_, not merely the one closest to a single cache. Distances come from one batched OSRM `/table` (candidates × caches, both directions); candidates whose shortest walk to any cache exceeds `maxLinkMeters` are dropped as bogus cross-barrier routes. When a mode finds nothing, `selectParking` returns `centroidFallback(...)` — the cluster centroid with `ParkingChoice.fallback = true` so the UI can flag "no parking found".
   - `auto` (default): `tryPqParking ?? tryOsmParking ?? tryCarRoadParking ?? centroidFallback` — the first source that yields a feasible (reachable within `maxLinkMeters`) start wins. `enumerateOsmParking` / `pickOsmParking` admit `startPreference === "auto"` alongside `"osm-parking"`, reusing the access/fee filter defaults.
   - `parking-waypoint`: enumerate the cluster's distinct `additional_waypoint(type='parking')` points (`enumeratePqParking`), then loop-aware pick.
   - `osm-parking` (ADR-0011): enumerate `parking_facilities` within `maxLinkMeters` of the centroid filtered by `osmParkingAccessFilter` + `osmParkingFeeFilter` (`enumerateOsmParking`), then loop-aware pick.
   - `osrm-nearest-road` (ADR-0012): snap onto **car-accessible** roads, not the foot graph. Enumerate the `PLANNER_ROAD_CANDIDATES` (default 12) eligible road segments closest to the **tour path** (the closed cycle line through the ordered caches — _not_ the centroid, so a road hugging a leg out at the cluster's edge can win) from the `car_roads` table (`CarRoadsRepository.findNearestRoadPoints`), reducing each to its `ST_ClosestPoint` "pull-over" point, then loop-aware pick. Eligible = `highway ∈ {residential, living_street, unclassified, service, tertiary}` (coarse, in the Lua import) minus `access`/`motor_vehicle ∈ {no, private}`, `maxspeed ≥ 70`, `service = driveway` (fine, at query time — retunable without a re-import). Falls back to the OSRM `/nearest` foot-snap of the centroid (flagged `fallback`) when no eligible road is reachable (rural gaps, or the table is absent in tests).
   - `user-supplied-point`: use `userSuppliedStart` verbatim (single candidate; `fallback = false`).
6. **Parking-insertion rotation** (`rotateForBestParkingInsertion` in `greedy-tsp-planner.ts`): the loop is always built as `parking → first … last → parking`, so parking splits exactly one cycle edge `(last → first)`. Since the cache-cycle edge sum is invariant under rotation, the loop total is minimised by attaching parking at the edge with the smallest insertion detour `parking→next + prev→parking − prev→next`. The `− prev→next` term is a geometric proxy for retrace: a _long_ skipped edge means parking sits on the way (cheap); a _short_ one makes it an out-and-back spur (expensive). The cycle is rotated so that edge becomes the entry/exit; `start = 0` reproduces the old fixed `last→first` behaviour and wins ties, so it's a strict, deterministic improvement, and it re-runs after every post-trim 2-opt restart. (For loop-aware modes the chosen parking already minimises this same cost — the rotation then aligns the loop to it.) This changes _where the loop attaches to parking_, not which cache is "nearest"; the first cache is still parking-adjacent by construction.
7. **Loop-aware leg picker** (apps/api/src/tours/strategies/greedy/loop-aware-legs.ts): per leg, OSRM `routeAlternatives` (up to 1 + `PLANNER_LOOP_ALT_COUNT`) are scored against an `OverlapGrid` of already-walked coordinates; the least-overlap alternative wins, with a via-waypoint nudge fallback when overlap exceeds `PLANNER_LOOP_NUDGE_THRESHOLD`.
8. **Post-leg-pick fringe trim** — the alternative-aware companion to the pre-trim. For each cache, compute the _retrace overlap_ between leg-in and leg-out via the same `OverlapGrid` (25 m cells by default). If any cache's overlap exceeds `input.fringeTrimMeters` (default 500), drop the worst one, re-2-opt the survivors, rebuild legs from scratch. Capped at 3 iterations. Coherent loop detours have ~0 overlap and survive; true cul-de-sac spurs have overlap ≈ 2 × spur length and get trimmed. See FR-T8 in [../requirements/tour-planning.md](../requirements/tour-planning.md).
9. Compose `PlanResult` with score breakdown + `droppedCacheIds` (union of pre-trim + post-trim drops; the UI renders these as gray-x markers).

## Why this works

- DBSCAN handles "find natural cluster" without asking the user to pick K.
- The Gaussian budget-fit term avoids picking the densest possible cluster when it would blow the distance budget (or be trivially short).
- NN+2-opt is exact-enough for the small N (≤ 50) we cap at; no need for OR-Tools yet.
- All randomness avoided so the same inputs produce the same output — easy to test, easy to reason about.

## Compute boundary — worker-thread pool (ADR-0014)

The CPU-heavy, **synchronous** parts of both passes run off the API event loop in
a piscina worker pool (`ComputePool`, `tours/compute/`), so one user's plan can't
block everyone else (the prerequisite for multi-user). Two task kinds cross the
boundary, both pure + serializable:

- **`tsp`** — `solveTwoOpt` (Pass 2's initial solve, the marginal-trim re-order,
  and each fringe-trim re-solve). The greedy planner `await`s the pool instead of
  calling the solver inline.
- **`cluster`** — the entire post-context Pass 1 pipeline (`computeClusters` in
  `discover-compute.ts`: strategy → refine → score → diagnostics).

The split is strict: **all I/O stays on the main thread.** `prepareClusteringContext`
(OSRM + Postgres), `routing.getMatrix`, the loop-aware leg building, and parking
selection all run on the main thread, which builds the serializable inputs
(distance matrix; the clustering context incl. its landuse `Map`) and hands them
to the pool. The worker imports only pure modules — the strategy registry was
split into `clustering/registry.ts` precisely so the worker never loads the
I/O-bearing `clustering/context.ts`. Determinism is unchanged (same pure
functions, just off-thread). Knobs: `PLANNER_WORKER_THREADS`,
`PLANNER_WORKER_TIMEOUT_MS` (see [../PLANNER_TUNING.md](../PLANNER_TUNING.md)).

## Manual edits — leg geometry swap (FR-T11)

After Pass 2 finishes, the planner attaches a per-leg array to `PlanResult.legs`. Each entry has `index`, `fromCacheId`/`toCacheId` (0 = parking sentinel), the picker's chosen `meters`/`seconds`/`geometry`, plus `alternatives[]` — every OSRM `routeAlternatives` candidate the loop-aware picker received, including the chosen one at `selectedAlternativeIndex`. No extra OSRM calls happen — the picker had to fetch these to score them anyway; we just surface them to the client instead of dropping the non-winning candidates on the floor.

On the client, `PlannerSidebar` keeps `legPicks: Record<legIndex, alternativeIndex>` in `localStorage`, keyed by a stable `planSignature(result)` (FNV-1a over `orderedCacheIds` + parking coords rounded to 5 decimals ≈ 1 m). This makes the picks **per-plan**:

- Reload the page → picks come back (same signature).
- Replan the same cluster → picks restored (signature unchanged).
- Replan a different cluster → no picks applied (different signature). Old picks stay in storage so coming back to the original plan still finds them.

`TourLayer` builds its displayed polyline from `legs.map(l => l.alternatives[picks[l.index] ?? l.selectedAlternativeIndex].geometry)`, and `PlanResultPanel` re-aggregates totals from the picked alternatives' `meters`/`seconds`. The GPX **track** export honours the override via a new optional `overridePolyline` arg to `planToGpxTrack`; the GPX **route** export is unchanged (route points are the cache list, not leg geometry). The JSON export attaches a `manualEdits` field — `{ planSignature, editedTotals, legPicks: [{ legIndex, originalAlternativeIndex, pickedAlternativeIndex, savedMeters, savedSeconds }] }` — so an offline analyser can see _which_ OSRM alternatives the picker chose and _which_ the human preferred. That's the input we want for tuning the loop-aware picker's overlap + via-waypoint heuristics in a future round.

Solver path emits `legs: []` (the Timefold sidecar doesn't currently fetch OSRM alternatives), and the edit-mode toggle is disabled in the UI for those plans.

### Live-drag via-waypoint

`POST /tours/legs/via-route` (`ViaRouteInput { fromCacheId, toCacheId, via: [lng,lat] }`) calls `osrm.routeMulti([from, via, to], "foot")` and returns the routed leg. The route is **not** persisted to `route_legs` — every drag position is unique so the cache would never hit, and we don't want to pollute `(from, to)` keys with geometry that depends on an ephemeral via.

Client side (`LegViaPointLayer`):

- Trailing-edge throttle at ~60 ms; at most one request in flight at a time; an `AbortController` cancels stale in-flights so the latest cursor position always wins.
- Marker dragging is wired to MapLibre's `mousedown` (with `dragPan.disable()`) → `mousemove` → `mouseup` pattern; a window-level `mouseup` listener catches the case where the user releases over the sidebar.
- Initial position seeded at the arclength-midpoint of whichever geometry the leg is currently displaying (planner pick or applied user alt).
- On dragend, the final OSRM response is committed to `legPicks[legIndex] = { kind: "via", via, meters, seconds, geometry }`. The geometry is persisted in `localStorage` so reloading restores the line without re-hitting OSRM; the via coord is kept so the user can "Re-grab via-point" to refine without starting over.
- NoRoute responses keep the last-good preview on screen and tint the marker red. Transient fetch failures fall back to the last successful preview and commit that.

The `resolvePick(leg, legPicks[i])` helper in `apps/web/src/lib/persistent-state.ts` is the single source of truth for "what geometry should this leg render as" — the `TourLayer`, `editedPolyline` (used for GPX track export), and JSON export all go through it, so via-picks and alt-picks are interchangeable from every consumer's perspective.

## Future strategy — `SolverTourPlanner` (M5+, not MVP)

Lives behind the same `TourPlannerStrategy` interface (see [ADR-0002](../adr/0002-planner-strategy-interface.md)). Recommended engines, in order:

1. **Timefold Solver** (Apache-2.0, OptaPlanner fork). Java; runs as a sidecar container exposing a thin REST/JSON solve endpoint. Good when soft constraints proliferate or N > 50.
2. Google OR-Tools (Apache-2.0). Python or C++ — heavier op cost.
3. MiniZinc (MPL).

Pick when there is a real reason the greedy planner falls short — don't preemptively adopt.
