# Tour planning algorithm — `GreedyTspPlanner`

MVP strategy, lives at `apps/api/src/tours/strategies/greedy/`. Pure TypeScript. Operator tuning knobs: [../PLANNER_TUNING.md](../PLANNER_TUNING.md).

## Pass 1 — cluster discovery

1. Spatial query: caches in `(center, radiusM)` satisfying `hardFilters` (PostGIS).
2. Project each cache to **local equirectangular meters** around `center` (cheap; accurate over our radius).
3. **DBSCAN** (`density-clustering` npm pkg) with adaptive ε:
   ```
   ε = clamp(distanceBudgetMeters / maxCaches / 2, 50m, 800m)
   minPts = max(3, floor(maxCaches / 4))
   ```
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
   - `count <= maxCaches`,
   - **running TSP lower bound** (MST length × 2) ≤ `distanceBudgetMeters`,
   - estimated time ≤ `timeBudgetMinutes` (if set), using `routing.getMatrix` averages.
2. Build the OD distance matrix via `routing.getMatrix(admittedIds)` — **walking distance**, symmetric, memoized per cache pair.
3. **TSP loop solver**: Nearest-Neighbor seed, then **2-opt** until no improving swap. Deterministic tie-breaks (lowest cache id wins). Lives in `packages/shared/src/tsp/two-opt.ts`.
4. **Pre-trim** — drop caches whose OSRM-primary marginal `(leg_in + leg_out − skip)` exceeds `input.maxLinkMeters`. Cheap; runs before any leg picking. Threshold migrated from the env-derived `resolveMarginalTrimThreshold` formula to the per-plan `maxLinkMeters` knob so both Pass-1 and Pass-2 trim respect the same user tolerance.
5. **Parking selection** by `startPreference`:
   - `parking-waypoint`: pick the `additional_waypoint(type='parking')` nearest the cluster centroid; reason = "Cache-owner parking near cluster centroid".
   - `osrm-nearest-road`: OSRM `/nearest` on the cluster centroid.
   - `user-supplied-point`: use `userSuppliedStart` verbatim.
   - `osm-parking` (ADR-0011): query `parking_facilities` within `maxLinkMeters` of the centroid filtered by `osmParkingAccessFilter` + `osmParkingFeeFilter`, then OSRM-walk each candidate to the cluster's nearest cache and pick the shortest within the cap. Falls back to OSRM-nearest if nothing fits.
6. **Loop-aware leg picker** (apps/api/src/tours/strategies/greedy/loop-aware-legs.ts): per leg, OSRM `routeAlternatives` (up to 1 + `PLANNER_LOOP_ALT_COUNT`) are scored against an `OverlapGrid` of already-walked coordinates; the least-overlap alternative wins, with a via-waypoint nudge fallback when overlap exceeds `PLANNER_LOOP_NUDGE_THRESHOLD`.
7. **Post-leg-pick fringe trim** — the alternative-aware companion to the pre-trim. For each cache, compute the *retrace overlap* between leg-in and leg-out via the same `OverlapGrid` (25 m cells by default). If any cache's overlap exceeds `input.fringeTrimMeters` (default 500), drop the worst one, re-2-opt the survivors, rebuild legs from scratch. Capped at 3 iterations. Coherent loop detours have ~0 overlap and survive; true cul-de-sac spurs have overlap ≈ 2 × spur length and get trimmed. See FR-T8 in [../requirements/tour-planning.md](../requirements/tour-planning.md).
8. Compose `PlanResult` with score breakdown + `droppedCacheIds` (union of pre-trim + post-trim drops; the UI renders these as gray-x markers).

## Why this works

- DBSCAN handles "find natural cluster" without asking the user to pick K.
- The Gaussian budget-fit term avoids picking the densest possible cluster when it would blow the distance budget (or be trivially short).
- NN+2-opt is exact-enough for the small N (≤ 50) we cap at; no need for OR-Tools yet.
- All randomness avoided so the same inputs produce the same output — easy to test, easy to reason about.

## Future strategy — `SolverTourPlanner` (M5+, not MVP)

Lives behind the same `TourPlannerStrategy` interface (see [ADR-0002](../adr/0002-planner-strategy-interface.md)). Recommended engines, in order:

1. **Timefold Solver** (Apache-2.0, OptaPlanner fork). Java; runs as a sidecar container exposing a thin REST/JSON solve endpoint. Good when soft constraints proliferate or N > 50.
2. Google OR-Tools (Apache-2.0). Python or C++ — heavier op cost.
3. MiniZinc (MPL).

Pick when there is a real reason the greedy planner falls short — don't preemptively adopt.
