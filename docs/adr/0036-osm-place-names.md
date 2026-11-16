# ADR-0036 — OSM place names for recognisable tour naming

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Raimond Brookman (owner)

## Context

A saved tour's default name and its exported GPX filename should be
**recognisable** — "Wageningen — 8.3 km · 12 caches", not "8.3 km loop". Until now
the only "place" anchor was the OSM **parking facility name**
(`parking_facilities.name`), which is set only when the tour starts at a *named*
OSM parking feature — rare, so names degraded to distance + cache count. The
owner asked for the place to come from the **town / area / nearby sight**, used
**consistently** in both the save name and the filename.

The osm2pgsql pass ([ADR-0009](0009-osm2pgsql-replaces-overpass.md)/[0011](0011-osm-parking-facilities.md)/[0012](0012-car-accessible-roads-for-nearest-road-parking.md))
imports `landuse_polygons` (kind only, no name), `parking_facilities`, and
`car_roads` — **no settlement (`place=*`) data and no named landuse**. So there was
nothing in the DB to resolve a town/area name from.

## Decision

1. **One more table in the same single osm2pgsql pass** (no new import job).
   `infra/osm2pgsql/osm-features.lua` gains a 4th output table **`place_points`**:
   named settlement **nodes** with `place ∈ {city, town, village, hamlet, suburb}`
   (+ `name`, `population`, `geom`). Finer kinds (neighbourhood / locality /
   isolated_dwelling) are excluded — too granular and they'd bloat the table.
2. **Named landuse for "sights".** Add a nullable `name` to the existing
   `landuse_polygons` (no new geometry — the polygons are already imported), so a
   tour inside a named park / forest / nature reserve can be named by it.
3. **Resolution is point *and* polygon, by feature type** (`PlacesRepository`):
   - **Sight / area = polygon containment.** If the tour's start anchor is
     **inside** a *named* `park`/`forest` (`ST_Contains`), use the smallest (most
     specific) one — "Bospark", "de Veluwe".
   - **Town = nearest point.** Else the nearest `place_points` node, **tiered by
     cap**: a `city`/`town` within **8 km**, else a `village`/`hamlet`/`suburb`
     within **4 km** (a city is recognisable from further than a hamlet). KNN on
     the GIST index, geography `ST_Distance` enforces the cap.
   - else no label.
4. **Resolved server-side, stored on the plan.** `ToursService.planLoop` resolves
   the label on the tour's parking point (best-effort — a failure never fails a
   plan) and sets `PlanResult.placeLabel`. `StoredPlan` extends `PlanResult`, so
   saved + shared tours carry it with no extra column.
5. **One client seam.** `tourPlace(plan) = placeLabel ?? parking.osm.name ?? null`
   feeds **both** `suggestTourName` (save) and `tourFilename` (download), so the
   two can never diverge.

## Alternatives considered

- **External reverse geocoder (Nominatim).** Rejected: against the
  self-hosted/no-external-API posture (we'd have to host it — heavy), and overkill
  for "nearest town".
- **Admin-boundary polygons for settlements.** Rejected: far heavier geometry than
  the `place=*` node, and containment is fuzzier than "nearest centre" for naming.
- **Street name (`car_roads.name`, already imported).** Rejected as the *primary*
  source — "Dorpsstraat" isn't a place — but `parking.osm.name` remains the
  client-side fallback under `placeLabel`.

## Consequences

**Good**
- Real, recognisable names ("Wageningen", "Bospark") in both the save prompt and
  the GPX filename, from one shared anchor.
- One extra indexed spatial query per plan — same cost class as parking selection;
  best-effort so it can never break planning.

**Trade-offs**
- **Storage:** a new point table — est. ~30–50k rows / ~5–15 MB incl. GiST index
  for NL + NRW (measured at import time via `place_points` size in the import log);
  plus a short text column on named landuse rows. Small next to the polygon/road
  tables. Place-kinds are tunable if it grows (drop `suburb`/`hamlet`).
- **A Lua change ⇒ a full osm2pgsql re-import** (`LANDUSE_FORCE_REIMPORT=1`) on dev
  + UAT to populate `place_points` and landuse names. One-time, ~30–40 min.
- The label is captured **at plan time**; tours saved before this have no label and
  fall back (parking name → distance + caches).

**Not in scope**
- Per-stage place labels; country/region in the name; localisation of the name.
