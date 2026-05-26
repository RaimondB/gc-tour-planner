# OSM context — Overpass

Lives at `apps/api/src/osm/`.

- **Cell scheme.** The world is divided into 0.1°-square cells (≈ 11 km × 7 km at lat 52°). `area_hash` is `"minLng,minLat"` rounded to two decimals. Every `osm_landuse` row records the cell it was fetched in via `(area_hash, osm_way_id)` (unique). Freshness is tracked per cell — `max(fetched_at)` per cell determines stale.
- **`OsmService.listLanduse({ bbox, kinds })`**:
  1. Snap `bbox` to all overlapping cells (capped at 0.6° per axis to prevent abuse).
  2. For each cell whose newest row is stale (>30 d) or missing → refresh from Overpass and `replaceCell` in one transaction.
  3. Query `osm_landuse` with `polygon::geometry && ST_MakeEnvelope(bbox)` (optionally `WHERE kind = ANY(:kinds)`) and return as a GeoJSON `FeatureCollection`.
- **Overpass query** (`HttpOverpassClient.fetchLanduse`):
  ```overpass
  [out:json][timeout:60];
  (
    way["landuse"~"^(forest|park|residential|farmland|industrial|meadow|heath|scrub)$"](minLat,minLng,maxLat,maxLng);
    way["natural"~"^(wood|water|wetland|heath|scrub)$"](minLat,minLng,maxLat,maxLng);
    way["leisure"~"^(park|nature_reserve)$"](minLat,minLng,maxLat,maxLng);
  );
  out tags geom;
  ```
  Closed ways only — relations (multipolygons) are deferred. Tags → canonical kind in `apps/api/src/osm/landuse-classify.ts`.
- **Caches `contexts` hard filter.** When `GET /caches?contexts=forest&contexts=park` is set, the query adds `WHERE EXISTS (SELECT 1 FROM osm_landuse l WHERE l.kind = ANY(:contexts) AND ST_Contains(l.polygon::geometry, c.location::geometry))`. The web app warms `/landuse` for the same bbox first so cells are populated.
- **Endpoint override.** Public Overpass by default; override via env `OVERPASS_URL`.
- **MVP fetch path is synchronous.** The DI'd `OverpassClient` is called directly on cache miss; a process-local `Map<areaHash, Promise>` dedupes concurrent requests for the same cell within one Node process. The cross-process Valkey lock and the BullMQ `overpass-refresh` queue (with serve-stale behavior) arrive with M4.
