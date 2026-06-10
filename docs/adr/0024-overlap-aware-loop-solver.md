# ADR-0024 — A side-by-side low-overlap loop solver

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0002](0002-planner-strategy-interface.md) (Pass-2 objective it amends), [ADR-0005](0005-timefold-solver-sidecar.md) (deferred scaling path), [ADR-0014](0014-planner-compute-worker-pool.md) (runs on the worker pool)

## Context

Pass 2 of the planner turns a chosen cluster into a routed closed loop. The default
solver, `solveTwoOpt` (Nearest-Neighbor → 2-opt → Or-opt VND in
`packages/shared/src/tsp/two-opt.ts`), minimises **Σ shortest(a→b)** over the OSRM
walking-distance matrix. That is great for total distance but **blind to two legs
sharing the same street** — the cause of the "walk the main street twice" retracing
on dense village clusters.

Every existing anti-retrace mechanism runs *after* the cache order is frozen and can
only patch geometry, never re-order: the loop-aware leg picker + via-waypoint nudge
(`loop-aware-legs.ts`), and the marginal/fringe trims. They can move a single leg
onto a parallel street or drop a spur cache, but they cannot choose a *cache order*
that avoids retracing in the first place.

The owner wanted to attack retracing at the ordering level, as a **selectable
option** that runs **side by side** with the existing solver — not a replacement.

## Decision

Add a second Pass-2 loop solver, `solveLowOverlapLoop`
(`packages/shared/src/tsp/low-overlap-loop.ts`), selected per plan via a new
`loopObjective: "shortest" | "low-overlap"` field on `PlanLoopInput` (env default
`PLANNER_LOOP_OBJECTIVE`, ultimately `shortest`). This mirrors the existing
`clusteringStrategy` idiom (request → env → fallback). `shortest` routes to the
untouched `solveTwoOpt`; `low-overlap` runs the new solver.

The new solver minimises:

```
cost(tour) = Σ leg_distance + β · retrace
retrace    = cellSize · Σ_cells max(0, coverCount(cell) − 1)
```

where `coverCount(cell)` is how many tour legs pass through a grid cell. Same
NN → 2-opt → Or-opt skeleton, but each move is scored on `distance + β · retrace`.

**Geometry source — straight-line proxy, not real OSRM geometry.** `retrace` is
computed from a cheap, deterministic, order-independent proxy: each leg is
approximated by the *straight segment* between its two caches, rasterised onto a
fixed grid (`leg-overlap.ts`). Real per-pair OSRM geometry would be more accurate
but is unavailable without ~N² extra `/route` calls (the matrix is built from OSRM
`/table`, which returns distances only — `route_legs.geom` is filled solely by
`/route`). The proxy's one weakness — collinear caches on a single street rasterise
to the same cells — is exactly the retracing signal we want to penalise in the
*order*. Realised-geometry accuracy is left to the existing loop-aware leg picker,
which is **untouched** (the proxy never feeds the picker's score, so there is no
double-penalty: the proxy shapes the *order*, the picker refines the *geometry*).

**In-process, not the sidecar.** The solver is pure TypeScript on the existing
piscina worker pool (ADR-0014) — no new service, JVM, or REST contract. The Timefold
sidecar (ADR-0005) remains the deferred path for when overlap must coexist with many
future soft constraints (terrain, landuse, pace) and larger N; that is a
constraint-composition justification, not a loop-shape one.

**Determinism preserved (NFR-4).** The new solver keeps the strict
`delta < bestDelta − 1e-9` improvement gate, the lower-index tie-break, and the
`MAX_VND_ROUNDS` bound, so it is monotone and terminating. `totalDistance` it returns
is pure distance (the marginal-trim math depends on that); `retraceMeters` is a
separate diagnostic.

## Consequences

- Two solvers coexist; `shortest` stays the default and the proven `two-opt.ts` is
  byte-for-byte unchanged (its tests are the regression guard). A few small pure
  helpers are duplicated into `loop-common.ts` rather than extracted, to avoid
  touching the default path.
- `β` (`PLANNER_LOOP_ORDER_BETA`, default 0.8) and the proxy grid
  (`PLANNER_LOOP_ORDER_GRID_M`, default 25) are tunable; see
  [PLANNER_TUNING.md](../PLANNER_TUNING.md).
- The retrace penalty double-counts cells covered by three or more legs (each
  contributes multiple pairwise overlaps). Accepted as a monotone approximation — it
  only ever over-penalises heavy retracing, which is the right direction.
- `low-overlap` may return a slightly longer loop than `shortest`; the distance
  budget is still enforced downstream, and the mode is opt-in.
