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
   - `clusterDensity` = `count / MST_length_m`.
   - `parkingPresence` = 1 if at least one cache in cluster has a `type='parking'` waypoint within 500 m, else 0.
   - `softConstraintScore` = sum of landuse + attribute + terrain/difficulty contributions across the cluster.
   - `budgetFit` = `exp(-((MST_length_m - distanceBudgetMeters) / distanceBudgetMeters)^2)` — Gaussian penalty for clusters too small or too large for the loop budget.
5. Return top **N** clusters (N = 5). User picks; or the API auto-picks the top one if `autoPick=true`.

## Pass 2 — refined loop

1. Greedy admission: take the top-scoring cluster, sort its caches by `softScore` desc, admit one by one as long as:
   - `count <= maxCaches`,
   - **running TSP lower bound** (MST length × 2) ≤ `distanceBudgetMeters`,
   - estimated time ≤ `timeBudgetMinutes` (if set), using `routing.getMatrix` averages.
2. Build the OD distance matrix via `routing.getMatrix(admittedIds)` — **walking distance**, symmetric, memoized per cache pair.
3. **TSP loop solver**: Nearest-Neighbor seed, then **2-opt** until no improving swap. Deterministic tie-breaks (lowest cache id wins). Lives in `packages/shared/src/tsp/two-opt.ts`.
4. **Parking selection** by `startPreference`:
   - `parking-waypoint`: pick the `additional_waypoint(type='parking')` nearest the cluster centroid; reason = "Cache-owner parking near cluster centroid".
   - `osrm-nearest-road`: OSRM `/nearest` on the cluster centroid.
   - `user-supplied-point`: use `userSuppliedStart` verbatim.
5. Prepend + append the parking-to-loop leg (OSRM `/route`). Concatenate all leg geometries → tour polyline.
6. Compose `PlanResult` with score breakdown.

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
