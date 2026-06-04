# ADR-0012 — Car-accessible roads layer for "nearest road" parking

- **Status:** Accepted
- **Date:** 2026-05-31
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0009](0009-osm2pgsql-replaces-overpass.md), [ADR-0011](0011-osm-parking-facilities.md)

## Context

The `osrm-nearest-road` start mode snaps the cluster centroid to the nearest node on the **foot** OSRM graph and returns that single point. Two problems:

1. The foot graph includes footpaths, pedestrian zones, and tracks where you cannot leave a car. OSRM `/nearest` returns no road class, so the result can't be filtered to "somewhere you can actually park."
2. It yields exactly one candidate, so it never benefits from the loop-aware insertion scoring (`pickLoopAwareParking` / `bestParkingInsertion`) that PQ and OSM-parking modes now use to pick the lowest-detour attach point.

The intent of this mode is the "pull over on a quiet road and walk in" case (mapped lots are already covered by `osm-parking`, ADR-0011). That is fundamentally a **road-class + access** question.

### Why not a car-profile OSRM

OSRM is foot-only by deliberate decision — a second car-profile instance OOMs the 16 GiB host (see `infra/osrm/bootstrap.sh`; one `osrm-routed` process serves one profile, and we need foot for the actual walking legs). Worse, even a car profile would **not** satisfy the requirement: its `/nearest` would happily snap to a motorway shoulder or an N-road (all "drivable"), and exposes no road class to filter them out. The information needed — `highway`, `access`, `maxspeed` — lives in the OSM tags, not in any OSRM graph.

## Decision

**Add `car_roads` as a third table populated by the existing osm2pgsql pass** (ADR-0009 single-Lua, one-PBF design), alongside `landuse_polygons` and `parking_facilities`. The `osrm-nearest-road` mode then:

1. Queries the K nearest eligible road segments to the cluster centroid (PostGIS, GiST-indexed), taking `ST_ClosestPoint(geom, centroid)` on each as the candidate "pull-over" point.
2. Runs those candidates through the **existing** `pickLoopAwareParking` selector (one batched OSRM `/table`, scored by `bestParkingInsertion`, `maxLinkMeters` reachability guard) — the same path PQ + OSM-parking use.
3. Falls back to the old foot-snap (`osrmNearestParking`) when no eligible road is reachable (rural gaps; or the table is absent, e.g. Testcontainers) so a plan is always produced.

OSRM stays foot-only. No wire/schema change — candidates are `ParkingChoice` `type: "osrm-nearest"`, so the web is unchanged.

### Eligibility filter

**Coarse, in Lua** (bounds table size): emit a way only when `highway ∈ {residential, living_street, unclassified, service, tertiary}`. Fast/through roads (`motorway/trunk/primary/secondary` + `_link`) and foot/cycle ways are never stored.

**Fine, at query time** (tunable without a re-import): drop `access`/`motor_vehicle ∈ {no, private}`, `maxspeed_kmh ≥ 70` (NULL passes — untagged minors are kept), and `service = 'driveway'`. The stored columns (`highway, access, motor_vehicle, maxspeed_kmh, service, name`) exist precisely so this fine filter can be retuned with a query change instead of a 30–40 min import.

### Why a separate table, not parking_facilities

Different geometry (open-way LineStrings vs nodes/polygons), different semantics (a road segment is not an amenity), different columns. Sharing would be a coupling tax for no win — same reasoning ADR-0011 used to keep parking out of landuse.

## Consequences

### Wins

- "Nearest road" parking lands on a road you can actually park-and-walk from, and is loop-aware like the other modes.
- The filter is owner-tunable at query time without re-importing.
- No second OSRM instance; OSRM stays foot-only and within the host's memory budget.

### Costs

- One migration, one Lua `define_table`, one repo, one planner branch.
- A one-time osm2pgsql re-import (`LANDUSE_FORCE_REIMPORT=1`, the full ~30–40 min pass) repopulates all three tables together.
- `car_roads` adds a few-million LineStrings for the NL(+NRW) extract (~hundreds of MB). GiST-indexed near-cluster queries stay fast; storage is well under the OSRM walking graph.
- Schema stays in lockstep across `osm-features.lua`, the migration, and the Kysely typings — same discipline as landuse + parking.

### Out of scope (deferred)

- Roadside `parking:lane`/`shoulder` tag awareness (we approximate "quiet road" by class + speed + access).
- The solver strategy (`solver-tour-planner.ts`) keeps its own foot-snap `pickParking`; bringing it onto the car-roads path is a follow-up when that engine comes online.
- Per-region road tuning; the filter is currently global.
