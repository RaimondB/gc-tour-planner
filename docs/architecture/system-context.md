# System context

```
                ┌──────────────────────┐
                │   Browser (React)    │
                │  MapLibre + filters  │
                └──────────┬───────────┘
                           │ HTTPS (JWT cookie)
                ┌──────────▼───────────┐
                │   NestJS API         │◄────── BullMQ ─────┐
                │  caches · tours ·    │                    │
                │  routing · osm · gpx │                    │
                │  sources · auth     ─┼──┐                 │
                └────┬────────┬────────┘  │                 │
            Kysely  │        │ HTTP       │                 │
                    ▼        ▼            │                 │
           ┌──────────────┐  ┌───────────┐│    ┌────────────▼──────────┐
           │ Postgres 16  │  │   OSRM    ││    │ Valkey                │
           │  + PostGIS 3 │  │  /route   ││    │  • job queue          │
           │  caches      │  │  /nearest ││    │  • Overpass dedup     │
           │  osm_landuse │  │  /table   ││    │  • OSRM hot cache     │
           │  route_legs  │  └───────────┘│    └────────────┬──────────┘
           │  tours       │               │                 │
           │  ...         │               │           ┌─────▼─────┐
           └──────────────┘               │           │ jobs      │
                                          │           │ workers   │
                                          │           │ (Node)    │
                                          │           └─────┬─────┘
                                          │                 │
                                          │      ┌──────────▼──────────┐
                                          └──────► Overpass API        │
                                                 │ (cached in DB+Valkey)│
                                                 └─────────────────────┘
```

External read-only data sources: OpenStreetMap (Overpass), self-hosted OSRM (built from an OSM extract), optional OKAPI nodes (M7), optional GC.com partner API (M8, feature-flagged off).
