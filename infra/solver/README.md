# solver — Timefold sidecar for `gc-tour-planner`

GPLv3-compatible (Apache-2.0 Timefold + Apache-2.0 Spring Boot). See [ADR-0005](../../docs/adr/0005-timefold-solver-sidecar.md).

## What it is

A standalone Spring Boot service that owns **Pass 2 only** of the planner — given a precomputed OSRM matrix and parking choice, it returns the visit order that maximises soft score subject to hard distance / time budget and reachability constraints.

Pass 1 (cluster discovery) is **not** in this service. `SolverTourPlanner` on the Nest side delegates Pass 1 to `GreedyTspPlanner` by composition.

## Build (locally)

```sh
cd infra/solver
mvn -B clean package
```

Produces `target/solver-0.1.0.jar`. A maven wrapper (`mvnw`) is intentionally not committed; install Maven 3.9+ on the path. The Dockerfile bundles its own.

## Run (locally, without docker)

```sh
SOLVER_SPENT_LIMIT=5s java -jar target/solver-0.1.0.jar
# → listens on :8080
curl http://localhost:8080/actuator/health
```

## Run (compose)

```sh
cd infra
docker compose up --build solver
```

Healthcheck polls `GET /actuator/health` and the `api` service waits on it.

## Wire contract

```
POST /plan
Content-Type: application/json
{
  "caches":                [{ "id": 1, "lng": 4.9, "lat": 52.4 }, ...],
  "matrixMeters":          [[0, 500, null], [500, 0, 700], [null, 700, 0]],
  "matrixSeconds":         [[0, 600, null], [600, 0, 800], [null, 800, 0]],
  "parkingToCacheMeters":  [120, 240, 200],
  "parkingToCacheSeconds": [150, 280, 240],
  "cacheToParkingMeters":  [130, 250, 210],
  "cacheToParkingSeconds": [160, 290, 260],
  "distanceBudgetMeters":  8000,
  "timeBudgetSeconds":     14400,
  "visitSecondsPerCache":  300,
  "weights":               { "visitedCount": 100 }
}

→ 200
{
  "orderedCacheIds": [1, 3, 2],
  "totalMeters":     1850.0,
  "totalSeconds":    2530.0,
  "visitedCount":    3
}
```

`null` cells in either matrix mark unreachable pairs. The solver treats any visit-order adjacency that hits a null cell as a hard violation, so unreachable insertions never survive in the final solution.

## Constraints (MVP — see `solver/TourConstraintProvider.java`)

| Type | Constraint      | Notes                                                                        |
| ---- | --------------- | ---------------------------------------------------------------------------- |
| HARD | distance budget | parking → first + inter-cache legs + last → parking ≤ `distanceBudgetMeters` |
| HARD | time budget     | only active when `timeBudgetSeconds` is supplied (`> 0`)                     |
| HARD | reachable legs  | rejects orderings with a `null` matrix cell                                  |
| SOFT | visited count   | rewards `visitOrder.size() × weights.visitedCount` (higher is better)        |

Deferred to a follow-up: terrain mix, difficulty mix, landuse preference, walking-pace fit. See ADR-0005 for the long-term vision.

## Determinism

Determinism is enforced via `timefold.solver.environment-mode=REPRODUCIBLE`, which pins the RNG and disables the parallelism that would otherwise perturb move ordering. (The Spring Boot starter does not expose `random-seed` as a property — REPRODUCIBLE mode is the Timefold-blessed way.) Same input ⇒ same output across runs.

The Nest-side determinism test (`apps/api/src/tours/strategies/solver/solver-tour-planner.spec.ts`) verifies same-input ⇒ same-output via a mocked client; the same expectation holds when the real sidecar is bound.

## Env vars

| Var                  | Default | Meaning                                      |
| -------------------- | ------- | -------------------------------------------- |
| `SERVER_PORT`        | 8080    | HTTP listen port (Spring Boot standard)      |
| `SOLVER_SPENT_LIMIT` | 5s      | Best-effort wall-clock cap on a single solve |

## Tests

```sh
mvn -B test
```

`TourConstraintProviderTest` covers each of the four MVP constraints in isolation via `ConstraintVerifier`. The Nest-side determinism + integration tests live in `apps/api`.
