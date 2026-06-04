# ADR-0014 — Planner CPU work on a worker-thread pool (piscina)

- **Status:** Accepted
- **Date:** 2026-05-31
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0002](0002-planner-strategy-interface.md), [ADR-0005](0005-timefold-solver-sidecar.md)

## Context

The NestJS API runs all planner computation on Node's single event loop. The
greedy planner's hot paths are CPU-bound and synchronous: `Tsp.solveTwoOpt`
(2-opt/Or-opt VND) in `planLoop`, and the clustering pipeline (Louvain + refine +
score) in `discoverClusters`. A single plan request recently spun the VND loop at
100% CPU and **blocked every other request** — caches, filter, health, all of it —
until a manual restart; it looked like a crash (it wasn't: `RestartCount=0`). We
shipped a VND iteration cap as a stop-gap, but the architecture remains fragile:
_any_ heavy or pathological input blocks all concurrent users. That's
unacceptable for multi-user (M6).

## Decision

**Offload the planner's pure-CPU computations to an in-process worker-thread pool
([piscina](https://github.com/piscinajs/piscina), MIT — GPLv3-compatible per
[LICENSING.md §2.1](../LICENSING.md)).** A `ComputePool` NestJS singleton owns one
piscina instance whose worker dispatches two task kinds:

- **`tsp`** → `solveTwoOpt(distances, startIndex, options)` (used by `planLoop`'s
  initial solve, the post-trim/fringe re-solve, and the marginal-trim re-order).
- **`cluster`** → the pure post-context discover pipeline (`strategy.cluster` →
  `refineClusters` → score loop → diagnostics), returning `{candidates, diagnostics}`.

Only **serializable pure functions** cross the worker boundary. All I/O — OSRM
HTTP, Postgres — stays on the main thread; the main thread builds inputs
(distance matrix, clustering context) and awaits results. Payloads are small and
structuredClone-safe (TSP ≤ 50×50 ≈ 20 KB; cluster context ≈ 150 KB incl. a
`Map<number,string[]>`).

### Why a pool, in-process, now

- **Multi-user is the driver:** one user's compute must not stall others. A pool
  sized to `PLANNER_WORKER_THREADS` lets concurrent requests' CPU work run in
  parallel while the event loop stays free for I/O.
- **In-process (vs a sidecar):** unlike the Timefold sidecar (ADR-0005, a separate
  Java service for a _different_, heavier solver), the greedy CPU work is small,
  pure TypeScript that already lives in this repo. Worker threads keep it
  co-deployed with zero new service, network hop, or container.
- **piscina over hand-rolled:** worker pools have subtle correctness (queueing,
  worker recycling on error, abort, idle teardown). piscina is the focused,
  battle-tested, MIT option; a hand-rolled pool would re-implement it. (The
  hand-rolled OSRM _semaphore_ is trivial by comparison; a thread pool isn't.)

### Boundary, timeout, shutdown

- The worker imports only pure modules (`@gctp/shared/tsp`, the extracted
  `discover-compute.ts`, and a new pure `clustering/registry.ts`). It must never
  import NestJS, services, or repositories — enforced by keeping the I/O importer
  `clustering/context.ts` out of the worker's graph (hence the registry split).
- Per-task **timeout** via `AbortController` (`PLANNER_WORKER_TIMEOUT_MS`, default
  30 s), mirroring `HttpSolverClient`. A task that blows the budget is aborted and
  surfaced as an error, not left to spin.
- **Graceful drain:** `ComputePool` implements `OnModuleDestroy` (→
  `pool.destroy()`); `main.ts` gains `app.enableShutdownHooks()` so SIGTERM drains
  instead of hard-killing workers mid-task.

## Consequences

### Wins

- A heavy/pathological plan can no longer freeze the whole API; the event loop
  keeps serving I/O and other users.
- CPU work parallelizes across cores under concurrent load.
- The discover pipeline becomes a **pure, directly unit-testable** function
  (`computeClusters`) — previously only reachable through DB/OSRM integration.

### Costs

- One MIT runtime dep (piscina) + a new worker file and pool service.
- Each offloaded call adds a postMessage round-trip (sub-ms for these payloads) —
  negligible against the OSRM time that already dominates a request.
- Refactor surface: extract `clustering/registry.ts` (pure strategy registry) and
  `discover-compute.ts` (pure pipeline) out of `greedy-tsp-planner.ts`, and make
  `trimMarginalCaches` await an injected async solve.

### Notes / out of scope

- The VND iteration cap stays as defense-in-depth (a runaway task still aborts on
  timeout, but the cap keeps single tasks bounded).
- Determinism is unchanged — identical pure functions run, just off-thread; tours
  and clusters are byte-for-byte the same, existing specs still hold.
- Not offloaded: the OSRM-bound leg building / walking-graph build (they're I/O,
  not CPU) and the Timefold sidecar path (separate, ADR-0005).
