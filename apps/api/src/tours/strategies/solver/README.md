# Solver strategy (Nest side)

Thin client + `TourPlannerStrategy` implementation for the Timefold sidecar. See [ADR-0005](../../../../../../docs/adr/0005-timefold-solver-sidecar.md) for the architectural decision and `infra/solver/README.md` for the Java sidecar.

## Files

- `solver-tour-planner.ts` — implements `TourPlannerStrategy`. Pass 1 delegates to `GreedyTspPlanner` (composition); Pass 2 calls the sidecar.
- `solver-client.ts` — `HttpSolverClient` + `SOLVER_CLIENT` DI token. 10 s default wall-clock timeout. Throws `ServiceUnavailableException` on failure (surfaces as 503 — no silent fallback to greedy).
- `solver-tour-planner.spec.ts` — Vitest determinism test against a mocked client.

## Enable

Set in `infra/.env`:

```
TOUR_PLANNER=solver
SOLVER_URL=http://solver:8080     # compose-internal hostname
```

Then `cd infra && docker compose up --build solver api`.

## Env vars (Nest side)

| Var                 | Default                 | Meaning |
|---------------------|-------------------------|---------|
| `TOUR_PLANNER`      | `greedy`                | `solver` switches the factory |
| `SOLVER_URL`        | `http://solver:8080`    | Sidecar base URL (no trailing slash) |
| `SOLVER_TIMEOUT_MS` | `10000`                 | Wall-clock cap on `/plan` |

## Known MVP gaps (deferred)

- Pass 1 (cluster discovery) still runs the greedy DBSCAN pipeline — no Timefold involvement.
- Constraint set is only: distance budget, time budget, reachable legs, visited count.
- No terrain mix / landuse / pace fit (will land alongside the weights schema).
- No graceful degrade to greedy when the sidecar is down — by design.
