# ADR-0002 — Pluggable `TourPlannerStrategy`

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** Raimond Brookman (owner)

## Context

The "find a closed walking loop with parking" problem is a constrained TSP with soft preferences. Solutions span a wide range:

- **Heuristics.** DBSCAN to find clusters; greedy admission + 2-opt for the loop. Fast, deterministic, easy to test, but no global optimality guarantee. Sufficient when N ≤ ~50 and soft constraints are few.
- **Constraint solvers.** Timefold / OptaPlanner / OR-Tools / MiniZinc. Better scoring, harder to operate (extra container, JVM/Python sidecar), slower per call, fewer maintainers in JS-land.

We want to ship the heuristic now (so M5 is reachable in the MVP timeline) but we also want the solver door open without rewriting the call sites.

## Decision

Define a `TourPlannerStrategy` interface in `apps/api/src/tours/strategies/`. NestJS injects an implementation by DI token; configuration (env var) selects which.

```ts
// packages/shared/src/tours/planner-strategy.ts

export interface TourPlannerStrategy {
  /** Pass 1 — top-N candidate clusters, ranked by score. */
  discoverClusters(
    ownerId: string,
    input: PlanInput,
  ): Promise<ClusterCandidate[]>;

  /** Pass 2 — turn a chosen cluster's cache-id set into a routed closed loop. */
  planLoop(ownerId: string, input: PlanLoopInput): Promise<PlanResult>;
}

export const TOUR_PLANNER = Symbol.for("@gctp/tours/TOUR_PLANNER");
```

`PlanInput`, `PlanLoopInput`, `ClusterCandidate`, and `PlanResult` live in `packages/shared/src/tours/`. They are versioned alongside the wire DTOs so client + server + strategies all share the same shapes.

**Why two methods, not one** _(M5-α revision, 2026-05-24)._ The original interface had a single `plan(PlanInput)`. While implementing the greedy planner we found that the UI needs to show the user candidate clusters before paying for the full OSRM matrix + per-leg geometry of any one of them, and that future solver strategies will want the same split (a cheap "show me my options" pass + an expensive "commit to this one" pass). Returning N PlanResults from one call would force the planner to do N times the work, even when the user only ever picks one. The two-method shape makes the cost honest at the API.

MVP ships:

- `GreedyTspPlanner` (`strategies/greedy/`) — DBSCAN clusters, NN + 2-opt loop, parking selection. Pure TypeScript, no extra services.

Designed-in but not implemented:

- `SolverTourPlanner` (`strategies/solver/`) — calls a sidecar HTTP solver. The wire format is JSON; the solver may be Timefold (preferred, Apache-2.0), OR-Tools (Apache-2.0), or MiniZinc (MPL). The Nest side is a thin client.

The factory in `tours.module.ts` picks the implementation:

```ts
{
  provide: Tours.TOUR_PLANNER,
  useFactory: (config, caches, routing, osrm) => {
    const flavor = config.get<string>('TOUR_PLANNER') ?? 'greedy';
    switch (flavor) {
      case 'greedy':
      default:
        return new GreedyTspPlanner(caches, routing, osrm);
      // case 'solver': return new SolverTourPlanner(...)  // added when M5+ needs it
    }
  },
  inject: [ConfigService, CachesService, RoutingService, OSRM_CLIENT],
}
```

## Alternatives considered

- **Ship the greedy planner without an interface.** Easier today, painful tomorrow — every call site couples to the algorithm.
- **Ship Timefold from day 1.** Adds a JVM sidecar, longer dev startup, harder CI, and we don't yet know which soft constraints actually need solver-grade scoring. Premature.
- **Plugin loaded at runtime (dynamic require).** Overkill for two implementations. Standard DI is plenty.

## Consequences

- A thin abstraction lives in M1 even though only one strategy exists. Acceptable cost.
- The wire types (`PlanInput`, `PlanResult`) become a stable contract — changes require a `_v2` field or a versioned route. We're OK with that; it's the right place to put the contract.
- Adopting a solver later is "add a strategy class + a sidecar container + flip an env var" — no controller changes.
- We must resist adding strategy-specific knobs to `PlanInput` ("solver patience"). Strategy-specific configuration lives in env vars or strategy-local config files.
