# Repository layout

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
├── docs/                      # requirements/, architecture/, design/, sdlc/, adr/, LICENSING.md
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
