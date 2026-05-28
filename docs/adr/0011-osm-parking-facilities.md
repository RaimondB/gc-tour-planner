# ADR-0011 — OSM parking facilities as an independent tour-start option

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0009](0009-osm2pgsql-replaces-overpass.md), [ADR-0010](0010-unified-osm-refresh.md)

## Context

GPX `parkingPoints` (cache-owner-curated waypoints) are too sparse for many clusters: lots of caches have no parking listed at all, and the ones present are single nodes contributed by individual cache owners. The first parking-preview UX (POST `/tours/parking-options` + `ParkingPreviewLayer`) hit the obvious failure case on day one — a cluster with one GPX parking that OSRM couldn't sensibly walk to, and no fallback because that was the only option in the data.

OpenStreetMap has crowd-sourced `amenity=parking` tagging across NL/NRW with rich attributes: polygon or node geometry, `access`, `fee`, `parking=*` (surface, multi-storey, …), `capacity`, `parking:condition`, `opening_hours`, `supervised`. OSRM throws this away when building its routing graph, but our existing osm2pgsql + Lua pipeline (ADR-0009) can ingest it on the same import pass for ~no extra cost.

## Decision

**Add `parking_facilities` as a second table populated by the existing osm2pgsql import**, alongside `landuse_polygons`. Expose it via:

1. A new `GET /parking-facilities` HTTP endpoint mirroring `GET /landuse` (bbox + access/fee filters, GeoJSON response).
2. A new `OsmParkingLayer` on the web map — polygons with a parking-P icon at the representative point, styled by access/fee. Always visible above z13.
3. A new `startPreference="osm-parking"` in the planner, with `osmParkingAccessFilter` and `osmParkingFeeFilter` knobs in `PlanSettings`.

**GPX parking is not touched.** The existing `parking-waypoint` and `osrm-nearest-road` start modes stay; users pick one start mode per plan.

### Why one Lua, not two

osm2pgsql flex-output supports any number of `osm2pgsql.define_*_table()` calls inside a single Lua script, all scanned in one PBF pass. The current `landuse.lua` is extended (renamed to `osm-features.lua` for clarity) to also define `parking_facilities` and emit rows for `amenity=parking` nodes/ways/relations. Single invocation in `bootstrap.sh`, both tables refreshed atomically, no `--append` gymnastics.

### Why a separate table, not landuse

Parking is logically distinct from landuse (you don't want a forest-fit score boosted by an `amenity=parking` polygon), the geometry types differ (nodes are common for parking, never for landuse), and the column set is wider (`access`, `fee`, `capacity`, …). A shared table would be a coupling tax for no win.

### Why an independent start mode, not a fallback

A fallback path ("try GPX, else try OSM") makes the planner non-deterministic from the user's perspective: identical inputs could produce different parking depending on data freshness in one of two sources. Two explicit modes are simpler to reason about and document. The user toggles per plan.

### Default access policy: `{yes, customers}`

`permit` is **opt-in**, not default — a permit-only lot that you don't have a permit for is functionally `private`. `private`, `no`, `destination` are never offered as start candidates (still rendered on the map, faded, for context). The user can flip `permit` on via the sidebar.

### Fee policy: no default preference

The sidebar surfaces a `Free | Paid | Any` segmented control, default `Any`. Paid parking is real and useful (especially urban geocaching); the planner shouldn't decide for the user. NL `parking:condition=disc` (free-with-disc, blue zones) is treated as `fee=no` upstream by OSM convention.

## Consequences

### Wins
- The planner can pick from hundreds of public lots per region instead of dozens of GPX waypoints.
- The "lonely cluster with one broken GPX parking" failure mode goes away in city centres and most villages.
- Map UX gets immediately better: every car-friendly cacher sees real parking before planning.
- Refresh cadence stays unified (ADR-0010) — both tables come from one PBF cycle.

### Costs
- One new migration, one new repo, one new endpoint, one new layer, one new planner branch. All small.
- The osm2pgsql import gets ~1.5× more rows (rough: landuse_polygons ~250 k for NL; parking_facilities probably ~50–100 k). Negligible compared to the OSRM walking graph.
- Schema must stay in lockstep between `osm-features.lua`, the migration, and the Kysely-generated types — same discipline as landuse.

### Out of scope (deferred)
- Charging-station detection (`amenity=charging_station`).
- Fee structure parsing (`charge=*`, `fee:conditional=*`). All `fee=yes` is uniform.
- Time-of-day eligibility (`opening_hours`, `maxstay`) — displayed in the popup, not enforced.
- Wheelchair / disabled-parking targeting (`capacity:disabled`).
- Saving user filter preferences across sessions.
