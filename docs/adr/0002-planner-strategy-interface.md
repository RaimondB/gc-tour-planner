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
// apps/api/src/tours/strategies/planner.interface.ts

export interface TourPlannerStrategy {
  plan(input: PlanInput): Promise<PlanResult>;
}

export const TOUR_PLANNER = Symbol("TOUR_PLANNER");
```

`PlanInput` and `PlanResult` live in `packages/shared/src/tours/`. They are versioned alongside the wire DTO so client + server + strategies all share the same shapes.

MVP ships:

- `GreedyTspPlanner` (`strategies/greedy/`) — DBSCAN clusters, NN + 2-opt loop, parking selection. Pure TypeScript, no extra services.

Designed-in but not implemented:

- `SolverTourPlanner` (`strategies/solver/`) — calls a sidecar HTTP solver. The wire format is JSON; the solver may be Timefold (preferred, Apache-2.0), OR-Tools (Apache-2.0), or MiniZinc (MPL). The Nest side is a thin client.

The factory in `tours.module.ts` picks the implementation:

```ts
{
  provide: TOUR_PLANNER,
  useFactory: (config: ConfigService) =>
    config.get('TOUR_PLANNER') === 'solver'
      ? new SolverTourPlanner(...)
      : new GreedyTspPlanner(...),
  inject: [ConfigService],
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
