# ADR-0013 — Walkable cycleways in a custom OSRM foot profile

- **Status:** Accepted
- **Date:** 2026-05-31
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0009](0009-osm2pgsql-replaces-overpass.md), [ADR-0012](0012-car-accessible-roads-for-nearest-road-parking.md)

## Context

Tour legs are routed by OSRM on its `foot` graph, built by `osrm-extract` from the **stock** `/opt/foot.lua` profile shipped in the `osrm-backend` image. That profile's `highway → walking_speed` table lists `footway, path, pedestrian, track, steps, service, residential…` but **not `cycleway`**. A bare `highway=cycleway` therefore gets no walking speed and is dropped from the foot graph; it is only routable on foot when it carries an explicit `foot=yes/designated/permissive` tag.

In the Netherlands this is pervasive: standalone *fietspaden* are tagged `highway=cycleway` with no `foot=*` (or `foot=no` because a separate sidewalk is mapped), even though they are walkable in practice. The symptom, observed empirically: a tour leg that should follow a cycleway instead detours onto the parallel car road, and a manual via-point can't fix it — OSRM `/nearest` at a point on the cycleway snaps **10.6 m away to the road** (`Sint Annastraat`), proving there is no foot edge on the cycleway at all.

This is independent of ADR-0012's `car_roads` table, which only snaps *parking* and never affects routing.

## Decision

Ship a **custom foot profile** that gives `highway=cycleway` the walking speed, so cycleways join the foot graph (unless foot is explicitly forbidden).

### Wrap, don't vendor

Rather than copy the whole upstream BSD profile into the repo (and pin to its version), `infra/osrm/foot-gctp.lua` loads the stock profile at runtime and patches one entry:

```lua
local stock = assert(loadfile('/opt/foot.lua'))()
local original_setup = stock.setup
stock.setup = function()
  local profile = original_setup()
  profile.speeds.highway.cycleway = profile.speeds.highway.footway -- = walking_speed
  return profile
end
return stock
```

The stock **access handler still runs**, so `foot=no` / `access=private` cycleways stay excluded — we add the *quiet, walkable* ones, not a blanket override. The profile + its `lib/` live in `/opt` in the image, so `loadfile` and the stock's `require('lib/..')` resolve there. The file is bind-mounted to `/opt/foot-gctp.lua` and selected via `PROFILE` in `infra/osrm/bootstrap.sh` — no image rebuild, and we stay decoupled from upstream profile churn.

### Version tag folds in the profile

The `route_legs` cache (and the leftover-ignore logic) is keyed on the OSRM extract version, previously `sha256(PBF)[:16]`. A profile change doesn't change the PBF, so cached legs from the old profile would be served stale. The version is now `sha256(sha256(PBF) ++ sha256(PROFILE))[:16]`, and the bootstrap re-extracts whenever a `${OSRM_BASE}.built-version` marker doesn't match. So changing the profile bumps the version → old cached legs are ignored and recomputed against the new graph, and the re-extract is self-triggering.

## Consequences

### Wins
- Tours follow cycleways where they should; fewer nonsensical car-road detours and "via-point won't take it" dead-ends.
- Self-healing: edit the profile → next OSRM boot re-extracts and the leg cache invalidates automatically.
- No upstream vendoring; the patch is three lines.

### Costs
- A one-time **OSRM foot-graph re-extract** (~10–15 min) on the shared UAT instance; routing is unavailable while it rebuilds. The `route_legs` cache is invalidated once (recomputed lazily on demand).
- The wrapper depends on the stock profile staying at `/opt/foot.lua` with an API-v2 `{ setup, process_way, … }` shape and a mutable `speeds.highway` table. If a future image changes that, the wrapper fails fast at extract time (visible in logs), not silently.

### Out of scope (deferred)
- `foot=use_sidepath` nuance (route the parallel footpath instead of the carriageway) — the stock handlers already cover the common cases; we don't add special logic.
- Surface/incline-aware walking speeds on cycleways (kept at flat `walking_speed`).
- A car routing profile (still off — one OSRM instance, foot only; ADR-0012 context).
