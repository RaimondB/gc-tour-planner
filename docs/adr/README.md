# Architecture Decision Records

We use lightweight ADRs (Michael Nygard style) to record decisions whose _why_ is non-obvious from the code.

**When to write an ADR:** any decision a future contributor (or future-you) would reasonably challenge — choice of framework, choice of license, choice of algorithm class, replacing a popular tool with a less popular one. Don't write one for naming, formatting, or routine refactors.

**Naming:** `NNNN-short-kebab-slug.md`, NNNN sequential and never reused.

**States:** `Proposed` → `Accepted` / `Rejected` → `Superseded by ADR-XXXX`. Never delete or rewrite a superseded ADR — write a new one that references it.

| #                                                             | Title                                                         | Status                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| [0001](0001-stack-choices.md)                                 | Tech stack (TypeScript + NestJS + React + PostGIS)            | Accepted                                      |
| [0002](0002-planner-strategy-interface.md)                    | Pluggable `TourPlannerStrategy`                               | Accepted                                      |
| [0003](0003-license-gplv3.md)                                 | License: GPL-3.0-or-later                                     | Accepted                                      |
| [0004](0004-valkey-over-redis.md)                             | Use Valkey instead of Redis                                   | Accepted                                      |
| [0005](0005-timefold-solver-sidecar.md)                       | Timefold as the solver-backed `TourPlannerStrategy`           | Accepted                                      |
| [0006](0006-docs-restructure-and-sync-policy.md)              | Docs restructure into per-area subdirectories + sync policy   | Accepted                                      |
| [0007](0007-precompute-walking-paths-on-upload.md)            | Precompute walking paths + landuse on GPX upload              | Accepted                                      |
| [0008](0008-self-host-overpass.md)                            | Self-host Overpass as a compose sidecar (shared with dev)     | Superseded by ADR-0009                        |
| [0009](0009-osm2pgsql-replaces-overpass.md)                   | Replace self-hosted Overpass with osm2pgsql + PostGIS         | Accepted; daily-diff path amended by ADR-0010 |
| [0010](0010-unified-osm-refresh.md)                           | Unified OSM refresh (drop daily landuse replication)          | Accepted                                      |
| [0011](0011-osm-parking-facilities.md)                        | OSM parking facilities table via the osm2pgsql pass           | Accepted                                      |
| [0012](0012-car-accessible-roads-for-nearest-road-parking.md) | Car-accessible road filter for nearest-road parking           | Accepted                                      |
| [0013](0013-walkable-cycleways-in-foot-profile.md)            | Walkable cycleways in the OSRM foot profile                   | Accepted                                      |
| [0014](0014-planner-compute-worker-pool.md)                   | Planner CPU work on a worker-thread pool (piscina)            | Accepted                                      |
| [0015](0015-isolated-network-dedicated-cloudflare-tunnel.md)  | gctp on an isolated network behind its own Cloudflare Tunnel  | Accepted; auth premise amended by ADR-0023    |
| [0016](0016-staged-dependency-upgrades.md)                    | Staged dependency upgrades (clusters, not big-bang)           | Accepted                                      |
| [0017](0017-nestjs-11-express-5-migration.md)                 | Migrate to NestJS 11 + Express 5 (+ multer 2)                 | Accepted                                      |
| [0018](0018-zod-4-shared-wire-contract.md)                    | Migrate to zod 4 (the shared wire contract)                   | Accepted                                      |
| [0019](0019-frontend-majors-react-vite-maplibre.md)           | Frontend majors: React 19 + Vite 8 + maplibre-gl 5 + Vitest 4 | Accepted                                      |
| [0020](0020-typescript-6.md)                                  | Migrate to TypeScript 6.0                                     | Proposed                                      |
| [0021](0021-auth-and-session-strategy.md)                     | Authentication & session strategy (argon2 + Valkey sessions)  | Accepted                                      |
| [0022](0022-tour-sharing-link-security.md)                    | Read-only tour sharing & link security                        | Proposed                                      |
| [0023](0023-staged-cloudflare-access-tunnel-removal.md)       | Staged removal of the Cloudflare Access gate (and Tunnel)     | Proposed                                      |
| [0024](0024-reticle-map-interaction.md)                       | Reticle map interaction for the Find step                     | Accepted                                      |
| [0025](0025-single-projection-planar-distance.md)             | One equirectangular projection per request for planning dist. | Accepted                                      |
| [0026](0026-boundary-spanning-clusters.md)                    | Boundary-spanning clusters (grow past the search radius)      | Accepted                                      |
| [0027](0027-icon-system-lucide.md)                            | Lucide as the app-wide UI icon set                            | Accepted                                      |
| [0028](0028-pwa-installability-offline-and-native-share.md)   | PWA install, offline saved tours, native GPX share            | Accepted                                      |
| [0029](0029-frontend-offline-resilience-caching-and-state.md) | Frontend offline resilience: caching, SW navigation, state    | Accepted                                      |
| [0030](0030-cloudflare-web-analytics.md)                      | Cloudflare Web Analytics (cookieless, prod-only beacon)       | Accepted                                      |
| [0031](0031-per-environment-app-identity-and-icon-split.md)   | Per-environment app identity + split display/maskable icons   | Accepted                                      |
| [0032](0032-service-worker-mediated-gpx-download.md)          | Service-worker-mediated GPX download in installed PWAs        | Accepted                                      |
| [0033](0033-machine-ingestion-api.md)                         | Machine ingestion API for external source adapters            | Accepted                                      |
| [0034](0034-adventure-lab-collapse.md)                        | Collapse Adventure Labs to one node for clustering + the map   | Accepted                                      |
| [0035](0035-compositional-marker-model.md)                    | Compositional marker model & colour-blind-safe palette         | Accepted                                      |
| [0036](0036-osm-place-names.md)                               | OSM place names (settlement nodes + named landuse) for tour naming | Accepted                                  |
| [0037](0037-location-awareness-and-follow-mode.md)            | Location awareness, nearby tours & follow-mode navigation     | Accepted                                      |
| [0038](0038-exclude-saved-tour-caches-from-discovery.md)      | Exclude saved-tour caches from cluster discovery (default on)  | Accepted                                      |
