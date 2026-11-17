# Walk planning — ad-hoc walk replan

Design for [FR-T18](../requirements/tour-planning.md); decisions in
[ADR-0040](../adr/0040-ad-hoc-walk-planning.md), privacy in the
[ADR-0037 amendment](../adr/0037-location-awareness-and-follow-mode.md).
Phase β (this) is the server side: the solver and `POST /walks/replan`. The
field UI (phase γ) calls it.

## Shape

```
client (walk session)            POST /walks/replan                 server (stateless)
 position, return point,  ───▶  WalkReplanInput  ───▶  WalksService.replan
 deadline, profile snapshot,                           1. time budget + pace
 calibration, done ids,                                2. locked next stop
 locked next, previous order                           3. candidate pool
                                ◀─── WalkReplanResult  4. costs (route_legs + 2 narrow OSRM tables)
                                                       5. solve (compute pool) + stability rule
                                                       6. schedule + geometry
```

Nothing about the walk is stored. The client resends the whole state each time
(`packages/shared/src/walks`).

## Steps (`apps/api/src/walks/walks.service.ts`)

1. **Time budget.**
   - `T = deadline − now − buffer` (seconds). Both times are the client's clock,
     so a skewed phone clock doesn't shift the budget.
   - Pace (`walk-plan.ts#walkPace`):
     - out = profile walking speed × `paceFactor` (clamped 0.6–1.5);
     - back = `min(out, profile)`, so the walk back is never optimistic;
     - visits = `visitMinutesFor(cache) × dwellFactor` (clamped 0.5–2).
2. **Locked next stop** (`lockedNextId`).
   - It must be one of the caller's caches; otherwise **404**.
   - One `/table` call (`sources`/`destinations`) gives `here→E`, `here→L` and
     `L→E`. The solver then starts at `L` with
     `T − (here→L) − visit(L)` left.
   - If `L→E` doesn't fit in that, the result is `feasible: false`,
     `order = [L]` and `lateByMinutes`.
3. **No time at all.** If `origin→E > T`: `feasible: false`, an empty order,
   and the reason "No time for caches".
4. **Candidate pool** (`candidatePool`).
   - The query is `CachesService.list` over the bounding circle of the reach
     ellipse, with the profile's filters: types, Multi subtype, D/T, tools,
     solved mysteries, landuse context, include disabled.
   - It always sets `excludeFound`. It also drops saved-tour caches when the
     profile says so, Adventure Labs when they're excluded, and everything
     visited, skipped or DNF'd on this walk.
   - It then keeps only caches inside the ellipse
     `hav(origin,c) + hav(c,E) ≤ T × speed`.
   - The pool is ranked by prize, then detour, and capped at
     `WALK_MAX_CANDIDATES`.
5. **Prize** (`cachePrize`):
   `1 + preferredWeight·[preferred type] + landuseWeight·[in a preferred landuse kind]`.
   Variety is applied by the solver as diminishing returns within a type.
6. **Costs.**
   - cache ↔ cache come from `RoutingService.getMatrix` (warm `route_legs`).
   - `origin → caches` and `caches → E` come from two narrow `/table` calls.
   - Metres are converted to seconds at the pace from step 1.
7. **Solve.**
   - `Tsp.solveOrienteering` runs in the compute pool, seeded with the
     previous order after `Tsp.repairPath`.
   - Stability rule: keep the repaired previous route unless the new score
     exceeds it by `max(1, WALK_HYSTERESIS_PCT % of it)`. The result reports
     `kept: "previous" | "new"`.
8. **Respond.**
   - Per-stop `arriveAt`/`leaveAt`, `returnAt`, `slackMinutes`, and
     `leaveLastBy` (latest departure from the last stop).
   - `minutesToReturn` (walking straight back).
   - The whole path geometry (`routeMulti`) and the next leg (`route`).

## Solver (`packages/shared/src/tsp/orienteering.ts`)

An open path with both ends fixed (`fromStart`, `toEnd`, `between` in seconds,
`null` = unreachable), each node with a `prize` and `visitSeconds`. The hard
limit is `travel + visits ≤ budgetSeconds`.

- **Score:** the sum of prizes. Within a type, the k-th cache (prizes sorted)
  counts `p / (1 + 0.5·varietyWeight·k)`.
- **Algorithm:**
  1. Greedy insertion by `Δscore / Δseconds` over all positions.
  2. Rounds of path 2-opt and or-opt (1–3 stops; they only shorten the path),
     re-insertion, and swapping a unit in the path for one outside it.
  3. Stop when a round doesn't improve, or after 50 rounds.

  There is no randomness, so the same input gives the same output.
- **Adventure Labs:**
  - *keep together*: insertion units are whole adventures (their remaining
    stages, in stage order);
  - *linear* stages keep `stageSequence` order;
  - *no interleave* keeps an adventure's stages contiguous.

  `isValidPath` enforces these on every move.
- **Measured:**
  - Brute force on 40 random 7-cache instances: always feasible and valid,
    and ≥ 95 % of the optimal score.
  - 60 candidates: median ~90 ms, worst ~170 ms per solve on the dev host.

## Privacy

- `position` / `returnPoint` exist only in the request body and are used for
  that request.
- The controller never echoes the body. A validation failure returns a generic
  400.
- `osrm-routed` runs at `--verbosity WARNING` (`OSRM_VERBOSITY`), so its
  per-request access lines, which carry coordinates, aren't written.
- Throttle: 30 replans / minute **per user** (`@Throttle` with a user-keyed
  tracker).
