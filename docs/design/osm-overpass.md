# OSM context — landuse + parking (was: Overpass)

> **Superseded.** This document was written when the OSM landuse context was fetched from Overpass at request time and stored cell-by-cell in `osm_landuse`. That whole pipeline has been removed.
>
> The current pipeline is a single osm2pgsql pass — described by [ADR-0009](../adr/0009-osm2pgsql-replaces-overpass.md), [ADR-0010](../adr/0010-unified-osm-refresh.md), and [ADR-0011](../adr/0011-osm-parking-facilities.md) — that populates two tables:
>
> * `landuse_polygons` — `MultiPolygon` features for 10 canonical kinds (`forest`, `park`, `residential`, …). Replaces the Overpass-fed `osm_landuse`.
> * `parking_facilities` — `Point | MultiPolygon` features for `amenity=parking`, with `access`, `fee`, `parking_type`, `capacity`, `maxstay`, etc.
>
> Both are produced by the same Lua filter at [infra/osm2pgsql/osm-features.lua](../../infra/osm2pgsql/osm-features.lua) and the same one-shot `osm2pgsql-import` compose service. Freshness lives in `landuse_import_meta` (single row); the operator-driven refresh script is [scripts/refresh-osm-data.sh](../../scripts/refresh-osm-data.sh).
>
> Lives at:
>
> - [apps/api/src/osm/landuse.repository.ts](../../apps/api/src/osm/landuse.repository.ts) — `GET /landuse`. Server-side LOD via `ST_SimplifyPreserveTopology` (tolerance scales with bbox width) + envelope-area floor + `LIMIT 5000` safety net.
> - [apps/api/src/osm/parking-facilities.repository.ts](../../apps/api/src/osm/parking-facilities.repository.ts) — `GET /parking-facilities`. Same LOD pattern + unconditional drop of `access=private`. Used by `OsmParkingLayer` on the map and by the `startPreference="osm-parking"` planner branch.
> - [apps/api/src/tours/strategies/pick-osm-parking.ts](../../apps/api/src/tours/strategies/pick-osm-parking.ts) — picks a candidate from `parking_facilities`, OSRM-walks each to the cluster's nearest cache, returns the shortest within `maxLinkMeters`.
>
> See [design/api-surface.md](api-surface.md) for the HTTP DTOs and [design/data-model.md](data-model.md) for the table schemas.
