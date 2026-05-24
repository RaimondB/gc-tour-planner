# Architecture

This document describes the system shape: services, repo layout, module responsibilities, and how data flows. Concrete schemas, algorithms, and API payloads live in [DESIGN.md](DESIGN.md). The _why_ behind each major choice lives in the ADRs.

## 1. System context

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

## 2. Repository layout

```
~/repos/gc-tour-planner/
├── apps/
│   ├── api/                   # NestJS service
│   │   ├── src/
│   │   │   ├── auth/          # JWT, current-user guard
│   │   │   ├── caches/        # search, filter, ingest
│   │   │   ├── gpx/           # PQ + generic GPX parsing + upload
│   │   │   ├── osm/           # Overpass client + cache
│   │   │   ├── routing/       # OSRM client + cache
│   │   │   ├── tours/         # cluster + TSP + save tour
│   │   │   │   └── strategies/ # GreedyTspPlanner (MVP), SolverTourPlanner (later)
│   │   │   ├── sources/       # adapters: okapi/, gc-com/ (flagged)
│   │   │   ├── jobs/          # BullMQ workers (prefetch, overpass refresh)
│   │   │   └── main.ts
│   │   └── test/
│   └── web/                   # React + Vite + MapLibre
│       ├── src/
│       │   ├── features/
│       │   │   ├── search/    # area + filters sidebar
│       │   │   ├── map/       # MapLibre wrapper + layers
│       │   │   ├── tour/      # cluster picker + loop preview
│       │   │   └── upload/    # GPX drag-and-drop
│       │   ├── lib/api.ts     # generated client from OpenAPI
│       │   └── main.tsx
│       └── e2e/               # Playwright specs
├── packages/
│   ├── shared/                # zod schemas, types, GPX parser, geo utils, TSP
│   ├── db/                    # Kysely schema types + migrations
│   └── config/                # eslint, prettier, tsconfig presets
├── infra/
│   ├── docker-compose.yml     # postgres, valkey, osrm, api, web, jobs
│   ├── docker-compose.dev.yml # hot-reload overrides
│   ├── osrm/                  # OSM extract download + osrm-extract/contract scripts
│   └── Dockerfile.*           # api, web, jobs
├── docs/                      # this file, REQUIREMENTS, DESIGN, LICENSING, ADRs
├── .claude/agents/            # subagent definitions for Claude Code
├── .github/workflows/         # ci.yml (lint+test+build), images.yml
├── CLAUDE.md                  # agent instructions for this repo
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

The monorepo is structured so:

- **`apps/`** = deployables.
- **`packages/`** = code shared between deployables. Anything you'd want to reuse from both `api` and `web` (zod schemas, GPX parser, geometry helpers, TSP solver) belongs in `packages/shared`.
- **`infra/`** = container orchestration + bootstrap scripts. The host-level dev experience is `docker compose up` from this folder.
- **No source code outside those three trees.** Don't drop helpers at the repo root.

## 3. Backend modules (NestJS)

Each module is a folder under `apps/api/src/`, exporting a `*.module.ts`. DI keeps adapters swappable.

| Module           | Responsibility                                                                                                      | Notable boundaries                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `auth`           | Local + Google OAuth, JWT in httpOnly cookie, `CurrentUser` guard.                                                  | Holds no third-party API creds. GC partner key lives in env, injected only into the `sources/gc-com` adapter.                    |
| `caches`         | `GET /caches` — spatial+filter query against PostGIS; returns rows + a `clustersHint` grid bucket.                  | Hard filters → SQL `WHERE`. Soft preferences → not applied here; the planner consumes them.                                      |
| `gpx`            | `POST /gpx/upload` multipart. Streams to the shared parser, upserts caches + additional waypoints.                  | Parser lives in `packages/shared/gpx/`. Per-user ownership enforced in the service, not the parser.                              |
| `osm`            | Overpass client. `getLanduseInBBox(bbox, kinds[])` reads `osm_landuse`; refreshes via Overpass when stale (> 30 d). | Valkey lock per bbox dedups concurrent fetches (thundering-herd protection). Refresh is enqueued to `jobs/`, not awaited inline. |
| `routing`        | OSRM client. `getLeg(fromId, toId, profile)` and `getMatrix(ids[])`, both with `route_legs` memoization.            | All OSRM calls go through here so the cache is centralized.                                                                      |
| `tours`          | Two-pass planning + persistence. Defers algorithm to a `TourPlannerStrategy` (DI token).                            | See [ADR-0002](adr/0002-planner-strategy-interface.md) and [DESIGN.md §Tour planning](DESIGN.md#tour-planning).                  |
| `sources/okapi`  | OpenCaching adapter — bbox queries, upserts with `source='okapi:<node>'`. (M7)                                      | Treat as a public source: rows are user-agnostic, no per-user RLS.                                                               |
| `sources/gc-com` | Groundspeak partner API adapter. (M8, feature-flagged off)                                                          | Single shared partner key from env. Rate-limited, request-cached.                                                                |
| `jobs`           | BullMQ workers: `overpass-refresh`, `prefetch-tiles`.                                                               | Workers run in a separate `jobs` container, not in the API process.                                                              |

### Layering rule

`controller → service → repository → kysely`. PostGIS spatial fragments are written as `sql\`ST_DWithin(...)\`` inside repositories. **Controllers never touch SQL.**

## 4. Frontend (React + Vite)

- **State.** TanStack Query for all server state. Local component state with `useState` / `useReducer`; **no** global store (Zustand/Redux) unless a concrete pain point appears.
- **Map.** A single `MapView` component wraps MapLibre. Layers (cache markers, landuse polygons, tour polyline, parking marker) are independent feature components that read query state and push sources/layers to the map ref.
- **Filter sidebar.** Owns the filter form state; pushes to the URL search params (so refresh and sharing preserve view). Debounced; calls `GET /caches` and `POST /tours/plan` via the generated client.
- **API client.** Generated from NestJS OpenAPI via `openapi-typescript-codegen` at build time. Never hand-write fetch calls.
- **Auth.** JWT cookie set by API on login; React reads `GET /auth/me` to know the current user. No tokens in localStorage.

## 5. Data flow — happy paths

### Upload → render

1. User drags a GPX file → `POST /gpx/upload` (multipart).
2. API: `gpx` service streams the file into the shared parser; upserts `caches` + `additional_waypoints`, scoped to `req.user.id`.
3. Web invalidates the `/caches` query → markers re-render.

### Filter → list

1. Sidebar updates filter state → debounced → `GET /caches?center&radiusM&types&attributes`.
2. API: `caches` repository runs `ST_DWithin` + type/attribute joins → returns rows + `clustersHint`.
3. Web sets the marker layer's GeoJSON source.

### Plan loop

1. User clicks "Plan loop" → `POST /tours/plan` with budgets + soft preferences.
2. API: `tours` service hands off to the injected `TourPlannerStrategy.plan(input)`.
3. Strategy (greedy MVP):
   1. PostGIS query for hard-filter-satisfying caches in radius.
   2. DBSCAN clusters (ε adapted to budget).
   3. Score clusters; pick top.
   4. Greedy admission → OD matrix via `routing.getMatrix` → 2-opt loop.
   5. Pick parking by `startPreference`.
4. Returns `PlanResult` → web renders polyline + parking marker + score breakdown panel.

### Save tour (M6)

1. User clicks "Save" → `POST /tours` with the previously-returned `PlanResult`.
2. API: `tours` service inserts into `tours`, scoped to `req.user.id`. Generates an opaque sharing slug.
3. Web shows the saved tour in "My tours".
4. Anonymous viewer hits `GET /tours/share/:slug` → read-only payload (no cache attribute weights, no profile internals).

## 6. Background work

Two BullMQ queues live behind Valkey:

- **`overpass-refresh`** — accepts a bbox + landuse kinds; the worker calls Overpass, upserts `osm_landuse`. Triggered by the `osm` service when its cache is stale.
- **`prefetch`** — opportunistic: warm OD legs around recently-viewed clusters. Cancellable; low priority.

Workers live in a dedicated `jobs` container (separate Node process) so a job storm doesn't degrade API latency.

## 7. Deployment topology

Single `docker compose up` brings everything up locally and in production. Services:

| Service    | Image                                           | Notes                                                                                                                                       |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `postgis/postgis:16-3.4`                        | Volumes: `pgdata`.                                                                                                                          |
| `valkey`   | `valkey/valkey:8`                               | Volumes: `valkey-data` (appendonly).                                                                                                        |
| `osrm`     | `osrm/osrm-backend` + `infra/osrm/bootstrap.sh` | On first start, downloads the OSM extract (region from env) and runs `osrm-extract` + `osrm-contract` (foot profile). Volumes: `osrm-data`. |
| `api`      | `infra/Dockerfile.api` (multi-stage)            | Reads DB + Valkey + OSRM + Overpass URLs from env.                                                                                          |
| `web`      | `infra/Dockerfile.web`                          | Nginx serving the Vite build; in dev, Vite dev server with HMR (override compose file).                                                     |
| `jobs`     | `infra/Dockerfile.jobs`                         | BullMQ workers; shares image layer cache with `api`.                                                                                        |

Production differs only in:

- `NODE_ENV=production`.
- TLS terminated upstream (reverse proxy / load balancer).
- Backups on `pgdata` and `osrm-data`.

## 8. What's intentionally _not_ here

- **Microservices.** This is a modular monolith plus job workers. Split only if a real scaling pressure shows up.
- **GraphQL.** REST + OpenAPI is enough; the client is generated.
- **A separate "domain" / DDD layer.** Services own use-cases directly; if logic grows, extract domain objects then.
- **Per-user Redis/Valkey databases.** A single Valkey instance with key prefixes is fine.
- **In-memory caching.** All caches are in Postgres or Valkey so a process restart doesn't lose them.
