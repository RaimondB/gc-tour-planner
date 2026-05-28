# Requirements — Tour planning

Cluster discovery, routed loop, parking selection. Algorithm in [design/tour-planning.md](../design/tour-planning.md); strategy interface in [ADR-0002](../adr/0002-planner-strategy-interface.md).

- **FR-T1.** Given (center, radius, hard filters, soft preferences, budgets), return a ranked list of **candidate clusters** suitable for a closed loop.
- **FR-T2.** For a chosen cluster, return a **planned loop**: ordered cache list, polyline along walking roads (OSRM), totals (meters, seconds, in-cache-visit time), and parking point.
- **FR-T3.** Budgets the user can set: `maxCaches` (default 15, cap 50), `distanceBudgetMeters` (default 8 000, cap 25 000), optional `timeBudgetMinutes` (using OSRM seconds + per-cache visit time, default 5 min/cache).
- **FR-T4.** Parking is selected by an explicit per-plan `startPreference` (no implicit fallback ordering):
  - `"parking-waypoint"` — Groundspeak parking waypoint nearest the cluster centroid (falls back to OSRM-nearest if none available).
  - `"osm-parking"` (ADR-0011) — OSM `amenity=parking` facility from the `parking_facilities` table, filtered by `osmParkingAccessFilter` (default `{yes, customers}`; `permit` is opt-in) and `osmParkingFeeFilter` (`free | paid | any`). The planner OSRM-walks each candidate to the cluster's nearest cache and picks the shortest within `maxLinkMeters`; falls back to OSRM-nearest if nothing fits.
  - `"osrm-nearest-road"` — cluster centroid snapped to the nearest walkable road.
  - `"user-supplied-point"` — explicit `userSuppliedStart` from the request.
- **FR-T8.** Fringe trim (post-leg-pick). After the loop-aware leg picker has tried OSRM alternatives, the planner computes a *retrace overlap* per cache (meters of leg-in geometry shared with leg-out via a 25 m hash grid). Any cache whose retrace exceeds `fringeTrimMeters` (default 500, range 100–3000) is dropped, the survivors are re-2-optimised, and legs are rebuilt — up to 3 iterations. Coherent loop detours have ~0 overlap and survive; true cul-de-sac spurs have overlap ≈ 2 × spur length and get trimmed.
- **FR-T9.** Pass-1 returns `topNClusters` ranked candidates (sidebar slider, default 5, max 20). The constant cap was removed so a large search area can surface more alternatives without redeploys.
- **FR-T5.** Return a **score breakdown** per soft constraint so the user understands why the loop scored as it did.
- **FR-T6.** Tour-planning is a pluggable strategy — see [ADR-0002](../adr/0002-planner-strategy-interface.md). MVP ships `GreedyTspPlanner` (DBSCAN → NN+2-opt); solver-based strategies plug in later.
- **FR-T7 (warm-cache reads).** Pass-1 cluster discovery reads walking distances from `route_legs` warmed by the upload-triggered precompute (FR-I8) — Pass 1 must not block on OSRM `/table` calls when the matching pairs are already cached. On a cold cache (no precompute job has run yet, e.g. a freshly-bootstrapped DB) the planner falls back to inline `/table` calls as today; the precompute is an optimization, not a correctness requirement.
