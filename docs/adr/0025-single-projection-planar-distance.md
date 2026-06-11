# ADR-0025 — One equirectangular projection per request for planning distances

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0014](0014-planner-compute-worker-pool.md), [ADR-0002](0002-planner-strategy-interface.md)

## Context

Every straight-line distance in the Pass-1 clustering pipeline (DBSCAN ε
fallback, MST length, the NN+2-opt tour-length estimate, geographic-outlier
trim, parking-presence) was computed with `haversineMeters` — a great-circle
formula evaluating four trig calls (`sin`/`cos`/`atan2`) per pair, on raw
`[lng, lat]`. The clustering hot paths are O(N²) in the candidate pool (up to
`MAX_DISCOVERY_POOL = 2000`), so that trig dominates the pure-CPU work the
worker pool ([ADR-0014](0014-planner-compute-worker-pool.md)) exists to contain.

A local equirectangular projection existed (`equirectangular.ts`) but was
**vestigial** — `makeEquirectangular` had no callers; all live distance math
went through `haversineMeters`.

The key constraint we were not exploiting: a plan request carries a search
**circle** — `PlanInput.center` plus `radiusM ≤ 50_000`. Every candidate cache
is therefore ≤ 50 km from a single known point. Over that range a flat
projection anchored at the centre deviates from the true great-circle distance
by under ~0.3% even for a pair at the circle's edge (the residual is cos(lat)
drift away from the reference latitude; curvature itself is < 0.01%), and far
less for the short nearby-cache legs clustering actually leans on. That error is
dwarfed by the ~1.3–1.4× straight-line→walking inflation the planner already
applies, and by OSRM replacing these estimates entirely in Pass 2.

## Decision

**Build one `Geo.Projection` per request, anchored at `input.center`, and use
its planar `distanceMeters` for every Pass-1 clustering/scoring distance.**

- New primitive `packages/shared/src/geo/projection.ts`:
  `makeProjection(refLng, refLat)` precomputes the metres-per-degree scale
  factors **once** from the reference latitude, then `distanceMeters(a, b)` is a
  plain Euclidean `hypot` of the per-axis degree deltas — no per-pair trig.
- The scale factors use the **FCC §73.208** polynomials
  (`metersPerDegreeLat/Lng`), which fit WGS84 to a few cm/deg — strictly more
  accurate than the flat `111_320 m/deg + cos(lat)` approximation, and more
  accurate than the spherical (`R = 6371 km`) haversine it replaces.
- The projection is built once in `prepareClusteringContext` and carried on
  `ClusteringContext.projection`, so every strategy / refinement stage reads the
  same instance (built once per request, like the rest of the context).

Converted to the projection: `discover-compute` (MST + tour estimate),
`clustering/refine` (cluster distance, geographic-outlier trim),
`clustering/dbscan` (graph-miss fallback), `cluster-scoring` (parking presence).

**Deliberately left on `haversineMeters`:**

- The API boundary (`tours.service`) and explain-endpoint diagnostics
  (`clustering/explain`, `walking-graph-debug`) — fields literally labelled
  "haversine" stay an honest great-circle reference number.
- The walking-graph suspicious-edge threshold (a 50 m sanity check during graph
  build, not a planning-decision metric).
- Pass-2's `nearestCacheIndexTo` parking pick (a per-insertion O(N) scan in a
  single cluster, not a hot loop).

## Consequences

- **Faster:** the O(N²) clustering loops drop four trig calls per pair to a
  couple of multiplies; the latitude-dependent work happens once per request.
- **Slightly different numbers (benign):** swapping spherical haversine for
  WGS84-FCC shifts every converted distance by a constant ~0.25% at our
  latitudes (FCC is the more accurate datum). Because clustering decisions are
  thresholds (`maxLinkMeters`) and ratios on *mutually consistent* distances,
  the constant offset cancels; only caches within ~0.25% of a threshold could
  flip, and the existing clustering unit tests are unaffected. Integration
  (Testcontainers) clustering fixtures should be re-run on merge.
- **Bounded accuracy:** valid only while `radiusM ≤ 50_000` and the projection
  is anchored at the circle centre. Raising the search radius materially would
  require revisiting the error budget (centre-anchoring keeps it tightest).
- `haversineMeters` and the (still-vestigial) `makeEquirectangular` remain for
  the boundary/diagnostic uses above; a later cleanup can fold them in.

## Alternatives considered

- **Per-pair midpoint-latitude scaling** (recompute cos at each pair's mean
  latitude): ~0.01% accuracy but reintroduces a per-pair `cos` and defeats the
  "compute once" goal. The single-projection error is already invisible under
  walking inflation, so the extra precision buys nothing.
- **Keep haversine, just memoise:** the trig, not lookup, is the cost; caching
  an O(N²) matrix trades CPU for memory without removing the per-pair work on
  cache-miss paths.
- **Drop haversine entirely:** rejected — the labelled diagnostics and the
  long-range API boundary genuinely want a canonical great-circle number.
