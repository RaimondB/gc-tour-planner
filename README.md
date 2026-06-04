# gc-tour-planner

Plan geocaching tours: pick a starting point and radius, filter caches by type / attributes / landuse (forest vs. city), find a dense cluster, and get a closed walking loop with a parking spot.

**Status:** early development (M1 — foundations). Nothing is runnable yet.

## What it will do (MVP)

- Define a search area by **center + radius** (default: current location).
- **Hard filter** caches by type (Traditional, Multi, …) and attributes (e.g. _dog-allowed_, _needs special tool_).
- **Soft preferences** scored against OpenStreetMap landuse polygons (prefer forest/park, avoid residential).
- Detect **clusters** of caches that admit a closed walking loop within a distance / time budget.
- Pick a **parking spot** — preferring parking waypoints embedded in Groundspeak GPX, falling back to the nearest OSRM-routable road.
- Save and re-open tours; share read-only links.

## How it will work

- **Data ingest:** GPX uploads (Groundspeak Pocket Queries + generic), plus optional OKAPI source adapter. A GC.com adapter is designed in but kept feature-flagged until partner-API approval.
- **Spatial backend:** Postgres + PostGIS holds caches, additional waypoints, cached OSM landuse polygons, and memoized routing legs.
- **Routing:** self-hosted OSRM (foot profile) preprocesses an OSM extract on first `docker compose up`.
- **Tour planner:** a pluggable [`TourPlannerStrategy`](docs/adr/0002-planner-strategy-interface.md). The MVP ships a pure-TypeScript greedy strategy — DBSCAN to find candidate clusters, then Nearest-Neighbor + 2-opt for the loop. A solver-based strategy (Timefold / OR-Tools) plugs in later behind the same interface.

## Repository

This is a pnpm + Turborepo monorepo:

```
apps/api    — NestJS service
apps/web    — React + Vite frontend (MapLibre GL JS)
packages/   — shared types, db migrations, lint/tsconfig presets
infra/      — docker-compose, OSRM bootstrap, Dockerfiles
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

TypeScript end-to-end. NestJS · React + Vite · MapLibre GL JS · Postgres 16 + PostGIS 3 · Kysely + node-pg-migrate · zod · BullMQ + **Valkey** (not Redis, see [ADR-0004](docs/adr/0004-valkey-over-redis.md)) · self-hosted OSRM · Docker Compose · GitHub Actions.

## License

[GPL-3.0-or-later](LICENSE) — see [docs/LICENSING.md](docs/LICENSING.md) for third-party data attribution (OpenStreetMap ODbL, Overpass, OSRM, MapLibre).

Geocache data sourced from Groundspeak (geocaching.com) is **not** redistributed by this project; users upload their own GPX files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). The roadmap is split into milestones M1–M8 in [docs/requirements/roadmap.md](docs/requirements/roadmap.md).
