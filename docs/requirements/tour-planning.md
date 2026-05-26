# Requirements — Tour planning

Cluster discovery, routed loop, parking selection. Algorithm in [design/tour-planning.md](../design/tour-planning.md); strategy interface in [ADR-0002](../adr/0002-planner-strategy-interface.md).

- **FR-T1.** Given (center, radius, hard filters, soft preferences, budgets), return a ranked list of **candidate clusters** suitable for a closed loop.
- **FR-T2.** For a chosen cluster, return a **planned loop**: ordered cache list, polyline along walking roads (OSRM), totals (meters, seconds, in-cache-visit time), and parking point.
- **FR-T3.** Budgets the user can set: `maxCaches` (default 15, cap 50), `distanceBudgetMeters` (default 8 000, cap 25 000), optional `timeBudgetMinutes` (using OSRM seconds + per-cache visit time, default 5 min/cache).
- **FR-T4.** Parking selection priority: (a) Groundspeak parking waypoint nearest the cluster centroid → (b) OSRM `/nearest` road point → (c) user-clicked point.
- **FR-T5.** Return a **score breakdown** per soft constraint so the user understands why the loop scored as it did.
- **FR-T6.** Tour-planning is a pluggable strategy — see [ADR-0002](../adr/0002-planner-strategy-interface.md). MVP ships `GreedyTspPlanner` (DBSCAN → NN+2-opt); solver-based strategies plug in later.
