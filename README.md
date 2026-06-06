# gc-tour-planner

Plan geocaching tours: pick a starting point and radius, filter caches by type / attributes / landuse (forest vs. city), find a dense cluster, and get a closed walking loop with a parking spot.

**Status:** actively developed and runnable end-to-end. Milestones **M1–M5 are shipped** — GPX ingest, map + filters, OSM context, routing infrastructure, and tour planning (cluster discovery → optimised loop → parking) all work, with a backend API, a React/MapLibre web app, and async precompute workers. Next up is **M6** (accounts, saved tours, share links). See the full breakdown in [docs/requirements/roadmap.md](docs/requirements/roadmap.md).

## What it does

- Define a search area by **center + radius** — use the browser's "use my location", or pan the map.
- **Hard filter** caches by type (Traditional, Multi, …) and attributes (e.g. _dog-allowed_, _needs special tool_).
- **Soft preferences** scored against OpenStreetMap landuse polygons (prefer forest/park, avoid residential), backed by three seeded profiles — forest-heavy, urban, balanced.
- Detect **clusters** of caches that admit a closed walking loop within a distance / time budget, and pick from the top candidates.
- Build the loop with a pure-TypeScript greedy planner (DBSCAN clustering → Nearest-Neighbor + 2-opt), with a score breakdown panel.
- Choose a **parking / start point** — from parking waypoints embedded in the Groundspeak GPX, nearby **OSM parking facilities**, or the nearest OSRM-routable road.
- Upload a GPX and watch routing + landuse **precompute** run in the background, with an operator panel and a queue dashboard.

### Coming next

- **M6** — accounts, server-saved tours, read-only share links. _(Shareable URLs already capture your search + plan as state; persistent saved tours land in M6.)_
- **M7** — OKAPI source adapter (Opencaching networks).
- **M8** — GC.com adapter, gated on partner-API approval and kept feature-flagged off.

## How it works

- **Data ingest:** GPX uploads today (Groundspeak Pocket Queries + generic). Per-user GPX isolation — uploaded caches are visible only to their owner. OKAPI (M7) and GC.com (M8) source adapters are designed in but not yet shipped.
- **Spatial backend:** Postgres + PostGIS holds caches, additional waypoints, OSM landuse polygons, OSM parking facilities, memoized routing legs, and per-cache precompute freshness state.
- **OSM context:** landuse polygons + parking facilities are imported into Postgres by a one-shot [osm2pgsql](docs/adr/0009-osm2pgsql-replaces-overpass.md) pass over an OSM extract (single Lua, two tables) — no Overpass sidecar.
- **Routing:** self-hosted OSRM (foot profile) preprocesses the OSM extract on first boot. GPX upload completion enqueues background **walking-precompute** (OSRM leg matrices for new caches' neighbours) and **landuse-refresh** jobs via BullMQ + Valkey, surfaced in an admin panel and a [bull-board](docs/adr/0007-precompute-walking-paths-on-upload.md) queue dashboard.
- **Tour planner:** a pluggable [`TourPlannerStrategy`](docs/adr/0002-planner-strategy-interface.md). The shipped strategy is a pure-TypeScript greedy planner — DBSCAN to find candidate clusters, then Nearest-Neighbor + 2-opt for the loop. A solver-based strategy (Timefold / OR-Tools) plugs in later behind the same interface.

## Run it

Prereqs: Node + [pnpm](https://pnpm.io), and Docker (for Postgres/Valkey/OSRM).

```bash
pnpm install        # bootstrap the monorepo

pnpm dev            # dev stack: postgres + valkey + shared OSRM, runs migrations,
                    # then api + web with hot reload and interleaved logs
pnpm dev:down       # stop dev infra (volumes preserved)
```

For a full production-shape stack (everything in containers, OSRM preprocessing + OSM import on first boot):

```bash
cd infra && cp .env.example .env && docker compose up --build
```

Common tasks: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:e2e` · `pnpm licenses:check`. More detail — including the dev/UAT split — is in [CLAUDE.md](CLAUDE.md) and [docs/sdlc/](docs/sdlc/index.md).

## Repository

This is a pnpm + Turborepo monorepo:

```
apps/api    — NestJS service (caches, gpx, osm, routing, tours, landuse-profiles, jobs, admin, …)
apps/web    — React + Vite frontend (MapLibre GL JS): search, map, planning, upload, admin
packages/   — shared zod types, db migrations + Kysely schema, lint/tsconfig presets
infra/      — docker-compose, OSRM bootstrap, osm2pgsql import, Dockerfiles
docs/       — requirements/, architecture/, design/, sdlc/, adr/, LICENSING, PLANNER_TUNING
```

Full layout and module-by-module breakdown: [docs/architecture/repo-layout.md](docs/architecture/repo-layout.md).

## Documentation

| Document                                         | What it covers                                  |
| ------------------------------------------------ | ----------------------------------------------- |
| [docs/requirements/](docs/requirements/index.md) | Functional + non-functional requirements        |
| [docs/architecture/](docs/architecture/index.md) | System architecture, repo layout, modules       |
| [docs/design/](docs/design/index.md)             | Data model, algorithms, API surface             |
| [docs/sdlc/](docs/sdlc/index.md)                 | Branching, testing, migrations, deploy, docs    |
| [docs/PLANNER_TUNING.md](docs/PLANNER_TUNING.md) | Every `PLANNER_*` env knob + symptom→knob guide |
| [docs/LICENSING.md](docs/LICENSING.md)           | GPLv3 compliance, third-party data terms        |
| [docs/adr/](docs/adr/)                           | Architecture Decision Records                   |

## Tech stack (locked)

TypeScript end-to-end. NestJS · React + Vite · MapLibre GL JS · Postgres 16 + PostGIS 3.4 · Kysely + node-pg-migrate · zod · BullMQ + **Valkey** (not Redis, see [ADR-0004](docs/adr/0004-valkey-over-redis.md)) · self-hosted OSRM · Docker Compose · GitHub Actions.

## License

[GPL-3.0-or-later](LICENSE) — see [docs/LICENSING.md](docs/LICENSING.md) for third-party data attribution (OpenStreetMap ODbL, osm2pgsql, OSRM, MapLibre).

Geocache data sourced from Groundspeak (geocaching.com) is **not** redistributed by this project; users upload their own GPX files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). The roadmap is split into milestones M1–M8 in [docs/requirements/roadmap.md](docs/requirements/roadmap.md).
</content>
</invoke>
