# Backend modules (NestJS)

Each module is a folder under `apps/api/src/`, exporting a `*.module.ts`. DI keeps adapters swappable.

| Module           | Responsibility                                                                                                      | Notable boundaries                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `auth`           | Local + Google OAuth, JWT in httpOnly cookie, `CurrentUser` guard.                                                  | Holds no third-party API creds. GC partner key lives in env, injected only into the `sources/gc-com` adapter.                    |
| `caches`         | `GET /caches` — spatial+filter query against PostGIS; returns rows + a `clustersHint` grid bucket.                  | Hard filters → SQL `WHERE`. Soft preferences → not applied here; the planner consumes them.                                      |
| `gpx`            | `POST /gpx/upload` multipart. Streams to the shared parser, upserts caches + additional waypoints.                  | Parser lives in `packages/shared/gpx/`. Per-user ownership enforced in the service, not the parser.                              |
| `osm`            | Overpass client. `getLanduseInBBox(bbox, kinds[])` reads `osm_landuse`; refreshes via Overpass when stale (> 30 d). | Valkey lock per bbox dedups concurrent fetches (thundering-herd protection). Refresh is enqueued to `jobs/`, not awaited inline. |
| `routing`        | OSRM client. `getLeg(fromId, toId, profile)` and `getMatrix(ids[])`, both with `route_legs` memoization.            | All OSRM calls go through here so the cache is centralized.                                                                      |
| `tours`          | Two-pass planning + persistence. Defers algorithm to a `TourPlannerStrategy` (DI token).                            | See [ADR-0002](../adr/0002-planner-strategy-interface.md) and [design/tour-planning.md](../design/tour-planning.md).             |
| `sources/okapi`  | OpenCaching adapter — bbox queries, upserts with `source='okapi:<node>'`. (M7)                                      | Treat as a public source: rows are user-agnostic, no per-user RLS.                                                               |
| `sources/gc-com` | Groundspeak partner API adapter. (M8, feature-flagged off)                                                          | Single shared partner key from env. Rate-limited, request-cached.                                                                |
| `jobs`           | BullMQ workers: `overpass-refresh`, `prefetch-tiles`.                                                               | Workers run in a separate `jobs` container, not in the API process.                                                              |

## Layering rule

`controller → service → repository → kysely`. PostGIS spatial fragments are written as `sql\`ST_DWithin(...)\`` inside repositories. **Controllers never touch SQL.**
