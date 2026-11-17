# ADR-0040 — Ad-hoc walk planning: open path, deadline, rolling replan

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0002](0002-planner-strategy-interface.md), [ADR-0005](0005-timefold-solver-sidecar.md), [ADR-0037](0037-location-awareness-and-follow-mode.md) (amended for this), [ADR-0039](0039-route-profiles.md) (profiles drive the walk); [FR-T18](../requirements/tour-planning.md).

## Context

The owner wants to plan **as they go**: start from where they are, pick a route
profile and a deadline, and always be back at the car (or another return point)
in time, without planning the whole tour in advance. The settled requirements
(FR-T18):

- **Rolling replan.** Always hold a complete, feasible, *tentative* route
  `here → caches → return point` that arrives before `deadline − buffer`; commit
  only the next stop; re-solve after Found / DNF / Skip, "Go here next", going
  off-plan, time drift, or a manual "Replan".
- **Stability.** Replace the tentative route only when the new one is clearly
  better; a user-chosen next stop is never replaced.
- **Manual override.** "Go here next" locks the next stop. If it can't be done in
  time, the user sees the cost ("~12 min late") and may confirm anyway.
- **Live calibration** of pace and visit time, never optimistic on the walk back.
- Profiles (ADR-0039) decide which caches count and what makes them interesting.

Today's planners can't express this:

- Both strategies plan **closed loops** from a parking point. `two-opt.ts` closes
  the tour; parking insertion, rotation and the marginal trim are cycle concepts;
  `PlanLeg` uses 0-sentinels for parking at both ends.
- Their objective is "most caches, then shortest", with no per-cache value.
- The Timefold sidecar has no pinned first visit, its latency is 0.5–5 s plus
  JVM warm-up, and it is unavailable whenever the sidecar is down.
- No endpoint receives the user's position (ADR-0037 §1).

## Decision

1. **A new pure-TS orienteering solver in `packages/shared/src/tsp/`**, not the
   Timefold sidecar and not a `TourPlannerStrategy`. A walk is a different
   problem (open path, deadline, prizes) with a different call pattern (many
   small, latency-sensitive re-solves), so it sits beside the strategies instead
   of stretching their closed-loop contract (ADR-0002 stays as is).
   - **Problem.** Fixed start `S` (the current position, or the locked next stop)
     and end `E` (the return point). Each candidate has a prize `p` and a visit
     time `d`. Travel time `t(a,b)` is routed metres at the walker's pace. Hard
     constraint: `Σ travel + Σ visits ≤ T`, where `T = deadline − now − buffer`.
     Objective: maximise the profile score (below); ties go to the shorter path.
   - **Heuristic.** Greedy insertion by `Δscore / Δtime`, then improvement passes
     with both ends fixed: path 2-opt, or-opt, and drop-and-add swaps. Bounded
     iterations in a fixed order (no randomness), so the same input always gives
     the same output, which the stability rule depends on.
   - **Adventure Labs** (ADR-0039 profile settings). *Keep together*: an
     adventure's remaining stages are one unit, inserted whole or not at all. A
     started adventure keeps only its remaining stages. *Linear*: stages keep
     `stageSequence` order, and moves that would break it are rejected. *No
     interleave*: a unit's stages stay contiguous.
   - It runs in the API's compute pool. Being pure TS, it can later run in the
     browser for offline replans (phase δ).
2. **Score (from the route profile).**
   - Each cache's prize is
     `p = 1 + preferredWeight·[type ∈ preferredTypes] + landuseWeight·[in a preferred landuse kind]`.
   - Variety is diminishing returns within a type: the k-th cache of a type
     (prizes sorted, k from 0) counts `p / (1 + 0.5·varietyWeight·k)`. With
     `varietyWeight = 0` it is a plain sum.
   - Visit time is `visitMinutesFor(cache)` (per-type minutes, AL stage time,
     tool bonus), the same function the planners use.
3. **Stateless replan API: `POST /walks/replan`.** The client sends the whole
   walk state each time: position (+ accuracy), return point, deadline, a
   profile snapshot, calibration, the visited / found / DNF / skipped ids, the
   locked next stop and the previous tentative order. The server keeps **no**
   walk session and persists nothing about the walk. The endpoint is
   authenticated, CSRF-protected and **throttled per user**.
   - **Candidate pool:** the owner's caches that match the profile filters, are
     not found, and were not visited, skipped or DNF'd on this walk. They must
     also lie inside the ellipse `hav(S,c) + hav(c,E) ≤ T · speed`. Straight
     line never exceeds walking distance, so this never wrongly excludes a cache.
     The pool is capped (`WALK_MAX_CANDIDATES`, default 60) by prize, then by
     detour.
   - **Costs:** cache ↔ cache from `RoutingService.getMatrix` (the warm
     `route_legs`). `S` and `E` rows come from **one** OSRM `/table` call using
     `sources` / `destinations`, which `OsrmClient.table` gains. Display geometry
     comes from one `routeMulti` over the tentative path, and the next leg is
     routed on its own.
4. **Time model and calibration.**
   - Travel seconds are `metres × 3.6 / speed`, where speed is the profile's
     walking speed × the client's calibrated pace factor (clamped to
     `0.6–1.5`).
   - Visit seconds are `visitMinutesFor × dwellFactor` (clamped to `0.5–2`).
   - **The walk back never uses a faster pace than the profile's:** legs into
     `E` use `min(calibrated, profile)` speed.
   - The client measures calibration; the server only clamps it.
5. **Stability (hysteresis), server-side.**
   - The previous tentative order is repaired: visited, skipped and no-longer-
     eligible caches are removed, then the lowest-value stops are dropped until
     it fits again. It is then scored under the fresh times.
   - The new solution replaces it only if its score is higher by at least
     `max(1 cache-equivalent, WALK_HYSTERESIS_PCT % of the old score)`
     (default 10 %), or if it scores no less and saves at least
     `WALK_HYSTERESIS_SAVE_MIN` minutes (default 10). The response says
     `kept: "previous" | "new"` and why.
   - The client skips the rule — sending no previous route — on a manual
     Replan and when the walker has gone off the route. In both cases the
     walker wants a plan from where they are now.
   - A locked next stop is always kept.
6. **Locked next stop.** The solver plans from `L` with what is left of the time
   after `S → L` and the visit at `L`. If even `S → L → E` doesn't fit, the
   response is `feasible: false` with `lateByMinutes`, and the tail is only the
   walk back. The client asks the user to confirm before locking it.
7. **Infeasible start.** If `S → E` alone exceeds `T`, the response is
   `feasible: false`, an empty order and the minutes needed to get back. The UI
   then says "No time for caches — X min to your return point".
8. **Privacy:** [ADR-0037](0037-location-awareness-and-follow-mode.md) is
   amended. The position and return point are sent only by replan calls during
   an active walk, are used for that request only, are never stored, and are
   never logged. `osrm-routed` runs at `--verbosity WARNING`, so its per-request
   access lines, which contain coordinates, are no longer written.

## Alternatives considered

- **Extend the Timefold sidecar** (pinned first visit, per-cache prizes, open
  path). Rejected for the walk: replans need low, predictable latency and must
  work when the sidecar is down; the heuristic has to run in the browser later;
  and the Java model would need prize-collecting changes that the closed-loop
  planner doesn't want. It stays the closed-loop Adventure Lab engine.
- **Make the walk a `TourPlannerStrategy`.** Rejected: the strategy contract is
  closed-loop Pass 1 / Pass 2 (`planLoop` returns a `PlanResult` with parking at
  both ends). Bending it would leak walk concepts into both existing planners.
- **Server-side walk sessions** (store the state, the client sends deltas).
  Rejected: that would store a live position trail server-side. Stateless
  requests keep the position ephemeral and make retries and offline catch-up
  trivial.
- **Greedy next-stop only** (no full tentative route). Rejected by the owner:
  it's myopic and can strand you with time left in a dead end.
- **On-device planning only.** Deferred (δ): needs a downloaded matrix bundle
  and can't cover detours outside it; the shared TS solver keeps the door open.

## Consequences

**Good**
- A walk is always backed by a complete, feasible route to the return point.
  The deadline guard has something concrete to check.
- Fast, deterministic, unit-testable solver with no sidecar dependency.
- The position never persists and stays out of logs.

**Trade-offs**
- A heuristic, not an exact orienteering solve: it can miss the best set on hard
  instances. A bench against brute force on small instances measures the gap.
- Every replan pays one OSRM `/table` call for the `S` and `E` rows (not
  cacheable: positions change). It is throttled per user, and the client debounces.
- AL handling is reimplemented in the heuristic instead of shared with the Java
  constraints, so both sets of rules need tests.
- Lower OSRM log verbosity also hides request lines that were handy when
  debugging the planner; set `OSRM_VERBOSITY=INFO` locally when needed.
