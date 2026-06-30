# ADR-0038 — Exclude saved-tour caches from cluster discovery (default on)

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0002](0002-planner-strategy-interface.md), [ADR-0026](0026-boundary-spanning-clusters.md); [FR-T16](../requirements/tour-planning.md), [FR-M16](../requirements/map-ui.md).

## Context

Pass-1 cluster discovery builds a candidate pool of the owner's caches within
`(center, radiusM)` and clusters it. The only deliberate omission so far is
`excludeFound` (you never plan a tour to a cache you've already logged). Caches
that already belong to a **saved tour** were still eligible — so re-running
discovery in an area you've already planned kept resurfacing the same caches and
proposing clusters you've effectively already done. The user wants discovery to
find **new** ground by default, while still being able to deliberately
re-discover over existing tours.

The data is readily available: `tours.cache_ids` is an `integer[]` column on each
saved tour, owner-scoped.

## Decision

Anti-join the discovery candidate pool against the union of the owner's
`tours.cache_ids`, gated by `PlanInput.excludeSavedTourCaches` (default
**true**).

1. **`SavedToursRepository.savedCacheIds(ownerId)`** — `SELECT DISTINCT
   unnest(cache_ids) FROM tours WHERE owner_id = $1`. Empty when the user has no
   saved tours.
2. **`CachesRepository.find({ excludeCacheIds })`** — a SQL `NOT (c.id =
   ANY($ids::bigint[]))` guard, mirroring the `excludeFound` pattern. Applied in
   SQL (not a post-fetch filter) so excluded caches never consume a slot in the
   `MAX_DISCOVERY_POOL = 2000` proximity cap — a user with many saved tours still
   gets 2000 *fresh* candidates.
3. **Server-internal only.** `excludeCacheIds` is passed via an internal `opts`
   arg to `CachesService.list`, **not** added to the public `CachesQuery` wire
   schema. The discovery path (`prepareClusteringContext`, fed
   `SavedToursRepository` only by the real `GreedyTspPlanner`) resolves and
   applies it; diagnostic callers (explain / walking-graph debug / benches) omit
   the dependency and see the full pool.

The override path is simply sending `excludeSavedTourCaches=false` (the web
"Skip caches already in my tours" toggle, off), which re-discovers clusters over
existing-tour caches. The flag is part of the discovery staleness key, so
flipping it marks the current candidates stale.

## Consequences

- **Pool-vs-map divergence, by design.** Like `excludeFound`, the exclusion
  narrows the *discovery pool* but **not** the map — saved-tour caches stay
  visible (and are now also drawn as footprints, [FR-M16](../requirements/map-ui.md)),
  so the user sees what's "taken" while discovery skips it. Keeping
  `excludeCacheIds` off the public `CachesQuery` schema is what prevents this
  from leaking into the map's `GET /caches`; a regression there would hide
  saved-tour caches from the map.
- **Partial-adventure caveat.** Excluding individual saved Adventure-Lab stage
  ids can leave a partial adventure in the pool, which `collapseAdventures` then
  collapses on the remaining stages. Acceptable for v1; whole-adventure
  exclusion (drop the adventure if any stage is saved) is a follow-up.
- **Cost.** One extra owner-scoped `unnest` query per discovery; negligible
  against the OSRM/landuse work in the same prelude.
- **Default-on** is the deliberate behaviour change: a returning user's
  discovery results shift toward unplanned ground. The toggle restores the old
  behaviour per-request.
