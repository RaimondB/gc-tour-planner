# Design

Concrete-level design — schemas, API shapes, algorithms. Read [../requirements/](../requirements/index.md) for _what_, [../architecture/](../architecture/index.md) for _how systems fit_, and the ADRs for _why we chose_ what we chose.

## Parts

- [Data model](data-model.md) — Postgres + PostGIS tables, spatial helpers, row-level access
- [API surface](api-surface.md) — selected endpoints with zod schemas
- [Auth + saved tours + sharing](auth-and-sharing.md) — M6 session model, guard swap, public-endpoint inventory, sharing links
- [Tour planning](tour-planning.md) — `GreedyTspPlanner` algorithm (Pass 1 + Pass 2)
- [Precompute](precompute.md) — upload-triggered `walking-precompute` + `overpass-refresh` jobs and `cache_precompute_state` lifecycle
- [GPX parsing](gpx-parsing.md) — Pocket Query + generic GPX
- [OSM context — Overpass](osm-overpass.md) — landuse fetch, cell scheme, hard-filter integration
- [Routing — OSRM](routing-osrm.md) — leg/matrix cache, foot profile
- [Frontend implementation notes](frontend.md) — TanStack Query keys, URL state, map layers
- [UX strategy](ux-strategy.md) — sidebar tab split, map-first single-screen principle, mobile drawer
- [Conventions](conventions.md) — naming, errors, logging, migrations, tests
- [Open design questions](open-questions.md) — deferred decisions
