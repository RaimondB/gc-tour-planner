# ADR-0005 — Timefold as the solver-backed `TourPlannerStrategy`

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** Raimond Brookman (owner)

## Context

[ADR-0002](0002-planner-strategy-interface.md) committed to a pluggable `TourPlannerStrategy` and shipped `GreedyTspPlanner` for the MVP. The greedy approach is fast, deterministic, and easy to test, but it's a fixed pipeline: DBSCAN → NN admission → 2-opt → parking pick. The optimization parameters that matter to a real user — terrain mix, difficulty mix, landuse preference, walking pace, distance vs. time trade-off — are baked into the algorithm rather than expressed as tunable weights.

We now want a second strategy that:

1. Lets us add or re-weight soft preferences without touching the algorithm.
2. Handles hard constraints (distance budget, time budget, parking-anchored start/end, finds-excluded) declaratively.
3. Plugs into the existing `SolverTourPlanner` slot already designed-in by ADR-0002.
4. Stays GPLv3-compatible.

## Decision

Adopt **[Timefold Solver](https://timefold.ai/)** (Apache-2.0, JVM) as the solver-backed strategy. Run it as a sidecar HTTP service in `infra/docker-compose.yml`. Implement `SolverTourPlanner` (`apps/api/src/tours/strategies/solver/`) as a thin client that POSTs a problem JSON and receives a `PlanResult`. Select it via `TOUR_PLANNER=solver` per the factory already wired in `tours.module.ts`.

**Why Timefold over the alternatives**

- **Constraint Streams** map each soft preference (terrain mix, landuse score, walking-pace fit, …) onto an independently-weighted rule. Weights are runtime config, not code edits — exactly the lever the user asked for.
- **Constraint Verifier** gives per-rule unit tests, so we can pin the meaning of each weight in CI.
- **Spring Boot starter** removes most of the JVM-deploy ceremony; the sidecar is a single `app.jar` in a slim JRE base image.
- **Apache-2.0** is unambiguously GPLv3-compatible (see [LICENSING.md §2](../LICENSING.md#2-hard-compatibility-rules)).

**Wire contract (sketch — fix in the implementation PR):**

```
POST /plan
{
  "caches":       [{ "id": 1, "lng": …, "lat": …, "terrain": 2.5, "landuseScore": … }, …],
  "matrixMeters": [[…], …],   // legs from /routing/matrix
  "matrixSeconds":[[…], …],
  "parkingCandidates": [{ "lng": …, "lat": … }, …],
  "constraints": {
    "distanceBudgetMeters": 12000,
    "timeBudgetSeconds":    14400,
    "minCaches": 5, "maxCaches": 20
  },
  "weights": { "terrainMix": 5, "landusePreference": 10, "walkingPaceFit": 3, … }
}
→ 200 { "orderedCacheIds": […], "parkingIndex": 2, "totals": {…}, "scoreBreakdown": {…} }
```

The matrix is precomputed by the Nest API (`RoutingService`) and passed in; the solver never calls OSRM. Keeping OSRM out of the solver image keeps the sidecar stateless and warm-startable.

## Alternatives considered

- **OR-Tools CP-SAT / Routing.** World-class TSP/VRP performance, Apache-2.0. Soft preferences must be encoded as terms in the single objective function — workable but harder to iterate on weights and harder to test per-rule. Better fit if we hit a performance wall Timefold can't clear.
- **VROOM.** Drop-in HTTP server, BSD-2-Clause, native OSRM integration. Matrix-driven; the soft-constraint API is limited (skills, priorities, capacity) and doesn't extend to arbitrary scoring rules we'd want for landuse / terrain mix.
- **JSprit.** Apache-2.0, JVM, lighter than Timefold. Less actively maintained; we'd give up Constraint Streams and Constraint Verifier — the two features that motivated this ADR.
- **MiniZinc + chuffed/gecode.** MPL-2.0; declarative and elegant. Smaller production ecosystem; expressing OSRM-driven routing with custom soft rules is awkward compared to Timefold or OR-Tools.
- **Stay on the greedy planner and add weighted scoring inline.** Tempting, but every new soft rule means another conditional in the admission loop; we lose the option to re-rank globally and we'd be rebuilding a worse solver.

## Consequences

- **Stack adds a JVM sidecar.** Cold start is seconds, not milliseconds; `docker compose up` is a touch slower. Acceptable — the solver is called only on **Plan loop**, not on map pan / filter.
- **No code change in `RoutingService` or `CachesService`.** The solver consumes precomputed matrices via the existing routing module.
- **`PlanInput` stays strategy-agnostic** (per ADR-0002 §Consequences). Timefold-specific knobs — termination budget, score-DRL tweaks — live in the solver sidecar's config, not on the wire.
- **Weight tuning becomes a product surface.** A future planner-sidebar can expose sliders that map straight to the `weights` object. We should add a server-side schema so the UI can't ship weights the solver doesn't recognize.
- **CI gains a JVM build job** for the sidecar (`infra/solver/`). License-checker already trusts Apache-2.0; no allowlist change needed.
- **Fallback path.** If the sidecar is unhealthy, the API should return `503` from `/tours/plan` when `TOUR_PLANNER=solver` rather than silently degrading to greedy. Silent fallback would mask outages and confuse weight tuning.
