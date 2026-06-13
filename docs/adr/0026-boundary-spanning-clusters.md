# ADR-0026 — Boundary-spanning clusters

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0002](0002-planner-strategy-interface.md), [ADR-0014](0014-planner-compute-worker-pool.md); supersedes the discarded "pool-only graph" hard-cutoff fix.

## Context

Pass-1 discovery builds a candidate **pool** of caches within `radiusM` of the
search centre, builds a sparse walking graph over it, and clusters it. But
`CachesRepository.nearestNeighbors` finds neighbours within `radiusM` of each
**origin** cache — reaching owner caches up to ~2× the radius from the centre,
i.e. **beyond the pool**. Those out-of-pool ids leaked into the seed-subgraphs
and clusters, then were silently dropped at hydration (the
`[discover-compute] refine→pool invariant broken` warning).

A `discovery-diag` sweep (40 seeds, louvain) measured the leak: **74.6% of
subgraphs contained foreign ids (10,744), 100% real same-owner caches**. The
user-facing candidates were still valid (foreign ids were filtered out), but a
real cluster straddling the search circle was **truncated at the boundary** — its
out-of-radius half discarded.

Two framings: (a) a bug — make the graph match the pool (hard cutoff at the
boundary); or (b) a missing feature — a cluster that sits half inside the circle
should be **fully detected**, not cut off. We chose (b).

## Decision

Let clusters **grow across the search boundary**, gated behind
`PLANNER_CLUSTER_GROW` (default-off). Three composable changes in
`prepareClusteringContext`, reusing the existing budget-bounded machinery:

1. **Enlarge the fetch** to `radiusM + distanceBudgetMeters/2` (same hard
   filters). `budget/2` is the principled bound: a cache can only join a
   budget-valid loop anchored on an in-radius seed if it is within ~half the
   budget's walk of it — so this is exactly "as far as a valid tour can reach",
   not an arbitrary margin.
2. **Seed only from the in-radius subset** (`selectGrowthPool` partitions the
   fetch; `selectSeeds` runs on the in-radius caches). Clusters still
   **originate** inside the search circle; they merely extend outward.
3. **Constrain the walking graph to the pool** (`buildWalkingGraph({ poolOnly })`).
   Because the pool now covers everything budget-reachable, the refine→pool
   invariant holds **by construction** — no leak, no warning.

Everything downstream is unchanged and already bounds growth: `extractSeedSubgraphs`
BFS is capped at `budget/2`, and `splitByMstCut` + admission cap clusters by
`maxCaches` + `distanceBudgetMeters`. With `grow=false` the fetch radius equals
the search radius and the whole pool is in-radius, so behaviour is byte-identical
to before.

## Consequences

- **Measured impact** (`discovery-compare`, 30 seeds, grow off→on): foreign ids
  6651 → **0**; returned candidates 44 → **73**; caches across candidates
  549 → **968** (+76%); candidate similarity 80.5%; 14/30 seeds unchanged. The
  feature recovers the cross-boundary halves of clusters; interior areas are
  untouched.
- The candidate pool fetch grows (up to `budget/2` wider), capped at
  `MAX_DISCOVERY_POOL = 2000` by proximity to the centre (in-radius caches kept
  first), and by the server-side `LIMIT`. Extra OSRM/PG work is bounded.
- Tours stay budget-valid: grown clusters are split/trimmed by the existing
  `maxCaches`/budget caps in refine and Pass-2.
- Ships default-off; flip `PLANNER_CLUSTER_GROW=1` after field validation. The
  `discovery-compare` harness (`apps/api/src/tours/bench/`) re-measures it.
- Supersedes the alternative "pool-only graph" fix, which produced a hard cutoff
  at the boundary (the opposite of the desired behaviour); the `poolOnly` graph
  flag survives as one ingredient of this feature.
- **Web client must mirror the grown pool.** The map's cache query is bounded by
  `radiusM`, but a grown cluster's members can sit in the `radiusM … radiusM +
  budget/2` halo. Rendering only the in-radius set made an edge cluster's marker
  count disagree with its `cacheIds.length` ("10 caches" but one dot). `apps/web`
  fetches a second `listCaches` at the grown radius (`excludeFound: true`, gated
  on clusters existing) and unions it in, so the visible set is a superset of the
  clustered set — member markers, camera-fit, carousel, export, and GPX all
  resolve. With grow off the extra caches are never cluster members, so the
  preview ignores them.
