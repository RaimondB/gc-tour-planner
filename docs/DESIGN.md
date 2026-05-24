# Design

Concrete-level design — schemas, API shapes, algorithms. Read [REQUIREMENTS.md](REQUIREMENTS.md) for _what_, [ARCHITECTURE.md](ARCHITECTURE.md) for _how systems fit_, and the ADRs for _why we chose_ what we chose.

## 1. Data model (Postgres + PostGIS)

Migrations live in `packages/db/migrations/` as plain SQL (`node-pg-migrate`). Kysely types are generated from the same schema.

### 1.1 Core tables

```sql
-- 0001_init.sql (sketch)

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT,                          -- nullable: OAuth-only users
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE caches (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     UUID REFERENCES users(id) ON DELETE CASCADE,   -- nullable for public-source rows
  source       TEXT NOT NULL,                                 -- 'gpx', 'okapi:<node>', 'gc-com'
  source_id    TEXT NOT NULL,                                 -- e.g. cache code 'GC12345'
  code         TEXT NOT NULL,
  type         TEXT NOT NULL,                                 -- Traditional, Multi, Mystery, ...
  name         TEXT NOT NULL,
  location     GEOGRAPHY(Point, 4326) NOT NULL,
  difficulty   NUMERIC(2,1),
  terrain      NUMERIC(2,1),
  size         TEXT,
  archived     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, source_id, owner_id)
);
CREATE INDEX caches_location_gist ON caches USING GIST (location);
CREATE INDEX caches_owner_idx ON caches (owner_id);

CREATE TABLE cache_attributes (
  cache_id BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  attr_id  INT NOT NULL,                                      -- Groundspeak attribute id
  positive BOOLEAN NOT NULL,
  PRIMARY KEY (cache_id, attr_id, positive)
);

CREATE TABLE additional_waypoints (
  id        BIGSERIAL PRIMARY KEY,
  cache_id  BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,                                    -- 'parking', 'reference', 'stages', ...
  location  GEOGRAPHY(Point, 4326) NOT NULL,
  note      TEXT
);
CREATE INDEX additional_waypoints_location_gist ON additional_waypoints USING GIST (location);

CREATE TABLE osm_landuse (
  id         BIGSERIAL PRIMARY KEY,
  area_hash  TEXT NOT NULL,                                   -- bbox+kinds hash, for cache lookup
  kind       TEXT NOT NULL,                                   -- 'forest', 'park', 'residential', ...
  polygon    GEOGRAPHY(Polygon, 4326) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX osm_landuse_polygon_gist ON osm_landuse USING GIST (polygon);
CREATE INDEX osm_landuse_area_idx ON osm_landuse (area_hash);

CREATE TABLE route_legs (
  from_cache_id BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  to_cache_id   BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  profile       TEXT NOT NULL,                                -- 'foot'
  meters        NUMERIC(10,2) NOT NULL,
  seconds       NUMERIC(10,2) NOT NULL,
  geom          GEOGRAPHY(LineString, 4326) NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_cache_id, to_cache_id, profile)
);

CREATE TABLE tours (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  start_point     GEOGRAPHY(Point, 4326) NOT NULL,
  parking_point   GEOGRAPHY(Point, 4326),
  cache_ids       BIGINT[] NOT NULL,
  total_meters    NUMERIC(10,2) NOT NULL,
  total_seconds   NUMERIC(10,2) NOT NULL,
  geom            GEOGRAPHY(LineString, 4326) NOT NULL,
  score_breakdown JSONB NOT NULL,
  share_slug      TEXT UNIQUE,                                -- nullable until shared
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tours_owner_idx ON tours (owner_id);

CREATE TABLE gpx_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  parsed_count INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,                                 -- 'pending', 'parsed', 'failed'
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE landuse_profiles (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id  UUID REFERENCES users(id) ON DELETE CASCADE,      -- NULL = system profile
  name      TEXT NOT NULL,
  weights   JSONB NOT NULL                                    -- {"forest":8,"park":4,"residential":-5}
);

CREATE TABLE preference_profiles (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 UUID REFERENCES users(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  attribute_weights        JSONB NOT NULL DEFAULT '{}'::jsonb,
  terrain_target           NUMERIC(2,1),
  difficulty_target        NUMERIC(2,1),
  time_per_cache_minutes   INT NOT NULL DEFAULT 5,
  weights                  JSONB NOT NULL DEFAULT '{}'::jsonb -- cluster, loop-compactness, etc.
);

CREATE TABLE cache_finds (
  cache_id  BIGINT NOT NULL REFERENCES caches(id) ON DELETE CASCADE,
  user_id   UUID   NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  found_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source    TEXT   NOT NULL,        -- 'manual' | 'gpx-finds-import' | 'gc-com'
  PRIMARY KEY (cache_id, user_id)
);
CREATE INDEX cache_finds_user_idx ON cache_finds (user_id);
```

A separate table (not a `found` column on `caches`) so that public-source rows in M7+ — where `owner_id IS NULL` — can still carry per-user finds without ambiguity.

### 1.2 Spatial helpers

- Radius search: `ST_DWithin(location, ST_MakePoint(:lng, :lat)::geography, :meters)` — uses the GIST index.
- Landuse context: `ST_Contains(landuse.polygon::geometry, caches.location::geometry)`.
- Tour polyline: assembled from `route_legs.geom` concatenated in visit order.
- Exclude-found filter: `NOT EXISTS (SELECT 1 FROM cache_finds f WHERE f.cache_id = c.id AND f.user_id = :userId)` — also used as a `foundByMe` boolean in the projection so the UI can dim still-shown found markers.

### 1.3 Row-level access

User-uploaded GPX caches have `owner_id` set. Source-adapter rows (OKAPI / GC.com) have `owner_id = NULL` and are world-readable. Repository methods take an explicit `userId` and union `(owner_id = :userId OR owner_id IS NULL)`. No Postgres RLS — enforced in the data layer because it's read-heavy and an `owner_id IS NULL` shortcut is faster than a row-by-row policy check. The `cache_finds` table follows the same pattern: every find query filters by `user_id` in the data layer.

## 2. API surface (selected endpoints)

OpenAPI spec is auto-generated from NestJS decorators. The TypeScript client is generated by `openapi-typescript-codegen` and lives at `apps/web/src/lib/api.ts`.

### 2.1 `GET /caches`

```ts
const CachesQuery = z.object({
  center: z.tuple([z.number(), z.number()]), // [lng, lat]
  radiusM: z.number().int().positive().max(50_000),
  types: z.array(z.enum(CACHE_TYPES)).optional(),
  attributes: z // AND-of-OR groups
    .array(z.array(z.object({ id: z.number(), positive: z.boolean() })))
    .optional(),
  contexts: z.array(z.string()).optional(), // landuse kinds to filter to (hard)
});
type CachesResponse = {
  caches: CacheDTO[];
  clustersHint: { gridCell: string; count: number }[];
};
```

### 2.2 `POST /gpx/upload`

Multipart upload. Returns `{ uploadId, parsedCount }`. Parsing is synchronous for small files (< 5 MB); large files are queued to `jobs/gpx-parse` and the client polls `GET /gpx/uploads/:id`.

### 2.3 `POST /tours/plan`

```ts
const PlanInput = z.object({
  center: z.tuple([z.number(), z.number()]),
  radiusM: z.number().int().positive().max(50_000),
  maxCaches: z.number().int().min(2).max(50).default(15),
  distanceBudgetMeters: z.number().int().positive().max(25_000).default(8_000),
  timeBudgetMinutes: z.number().int().positive().max(720).optional(),
  hardFilters: z.object({
    types: z.array(z.enum(CACHE_TYPES)).optional(),
    attributes: z.array(z.array(AttrFilter)).optional(),
  }),
  softPreferences: z.object({
    landuseProfileId: z.string().uuid().optional(),
    attributePreferences: z.record(z.string(), z.number()).optional(),
    difficultyTarget: z
      .object({ value: z.number(), tolerance: z.number(), weight: z.number() })
      .optional(),
    terrainTarget: z
      .object({ value: z.number(), tolerance: z.number(), weight: z.number() })
      .optional(),
    clusterDensityWeight: z.number().default(1),
    loopCompactnessWeight: z.number().default(1),
  }),
  startPreference: z
    .enum(["parking-waypoint", "osrm-nearest-road", "user-supplied-point"])
    .default("parking-waypoint"),
  userSuppliedStart: z.tuple([z.number(), z.number()]).optional(),
});

type PlanResult = {
  orderedCacheIds: number[];
  polyline: GeoJsonLineString;
  totals: { meters: number; seconds: number; visitMinutes: number };
  parking: {
    type: "pq" | "osrm-nearest" | "user";
    point: GeoJsonPoint;
    reason: string;
  };
  scoreBreakdown: Record<string, number>;
};
```

### 2.4 `POST /tours` and `GET /tours/share/:slug`

Save a `PlanResult` as a named tour; optional sharing slug. Shared payload omits soft-preference internals.

## 3. Tour planning algorithm — `GreedyTspPlanner`

MVP strategy, lives at `apps/api/src/tours/strategies/greedy/`. Pure TypeScript.

### 3.1 Pass 1 — cluster discovery

1. Spatial query: caches in `(center, radiusM)` satisfying `hardFilters` (PostGIS).
2. Project each cache to **local equirectangular meters** around `center` (cheap; accurate over our radius).
3. **DBSCAN** (`density-clustering` npm pkg) with adaptive ε:
   ```
   ε = clamp(distanceBudgetMeters / maxCaches / 2, 50m, 800m)
   minPts = max(3, floor(maxCaches / 4))
   ```
4. For each cluster, score:
   ```
   score = clusterDensity * w_density
         + parkingPresence * w_parking
         + softConstraintScore * w_soft
         + budgetFit * w_budget
   ```
   - `clusterDensity` = `count / MST_length_m`.
   - `parkingPresence` = 1 if at least one cache in cluster has a `type='parking'` waypoint within 500 m, else 0.
   - `softConstraintScore` = sum of landuse + attribute + terrain/difficulty contributions across the cluster.
   - `budgetFit` = `exp(-((MST_length_m - distanceBudgetMeters) / distanceBudgetMeters)^2)` — Gaussian penalty for clusters too small or too large for the loop budget.
5. Return top **N** clusters (N = 5). User picks; or the API auto-picks the top one if `autoPick=true`.

### 3.2 Pass 2 — refined loop

1. Greedy admission: take the top-scoring cluster, sort its caches by `softScore` desc, admit one by one as long as:
   - `count <= maxCaches`,
   - **running TSP lower bound** (MST length × 2) ≤ `distanceBudgetMeters`,
   - estimated time ≤ `timeBudgetMinutes` (if set), using `routing.getMatrix` averages.
2. Build the OD distance matrix via `routing.getMatrix(admittedIds)` — **walking distance**, symmetric, memoized per cache pair.
3. **TSP loop solver**: Nearest-Neighbor seed, then **2-opt** until no improving swap. Deterministic tie-breaks (lowest cache id wins). Lives in `packages/shared/src/tsp/two-opt.ts`.
4. **Parking selection** by `startPreference`:
   - `parking-waypoint`: pick the `additional_waypoint(type='parking')` nearest the cluster centroid; reason = "Cache-owner parking near cluster centroid".
   - `osrm-nearest-road`: OSRM `/nearest` on the cluster centroid.
   - `user-supplied-point`: use `userSuppliedStart` verbatim.
5. Prepend + append the parking-to-loop leg (OSRM `/route`). Concatenate all leg geometries → tour polyline.
6. Compose `PlanResult` with score breakdown.

### 3.3 Why this works

- DBSCAN handles "find natural cluster" without asking the user to pick K.
- The Gaussian budget-fit term avoids picking the densest possible cluster when it would blow the distance budget (or be trivially short).
- NN+2-opt is exact-enough for the small N (≤ 50) we cap at; no need for OR-Tools yet.
- All randomness avoided so the same inputs produce the same output — easy to test, easy to reason about.

### 3.4 Future strategy — `SolverTourPlanner` (M5+, not MVP)

Lives behind the same `TourPlannerStrategy` interface (see [ADR-0002](adr/0002-planner-strategy-interface.md)). Recommended engines, in order:

1. **Timefold Solver** (Apache-2.0, OptaPlanner fork). Java; runs as a sidecar container exposing a thin REST/JSON solve endpoint. Good when soft constraints proliferate or N > 50.
2. Google OR-Tools (Apache-2.0). Python or C++ — heavier op cost.
3. MiniZinc (MPL).

Pick when there is a real reason the greedy planner falls short — don't preemptively adopt.

## 4. GPX parsing

Lives at `packages/shared/src/gpx/parse.ts`. Pure function, used identically from `apps/api` (upload) and potentially from `apps/web` (preview).

- Streams via `sax` / `htmlparser2` — never buffers > 1 MB.
- Recognized extensions: `groundspeak:cache`, `groundspeak:attributes`, `groundspeak:short_description`, `groundspeak:long_description`.
- Additional waypoints: any `<wpt>` whose name starts with `PK` / `RP` / `ST` etc. _or_ whose `<sym>` is one of {`Parking Area`, `Reference Point`, `Stages of a Multicache`, `Trailhead`, `Final Location`, `Question to Answer`}. Map symbol → internal `type`.
- Output: `{ caches: ParsedCache[]; waypoints: ParsedWaypoint[]; warnings: string[] }`. No DB side effects — the caller upserts.

## 5. OSM context — Overpass

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

## 6. Routing — OSRM

Lives at `apps/api/src/routing/`.

- `getLeg(fromId, toId, profile='foot')` reads `route_legs`; on miss, calls `OSRM_URL/route/v1/foot/{from};{to}?overview=full&geometries=geojson` and persists.
- `getMatrix(ids[])` reads/writes `route_legs` pairwise; falls back to OSRM `/table/v1/foot/{coords}` for fresh full matrices when no rows are cached.
- Foot profile only at MVP. Other profiles deferred to post-MVP.

## 7. Frontend implementation notes

- **TanStack Query keys** mirror endpoint shape: `['caches', { center, radiusM, types, attributes, contexts }]`.
- **URL state**: filter form synced to `URLSearchParams` so reload + share preserve the view. Map center/zoom too.
- **Map layers** (MapLibre source/layer ids):
  - `caches-src` / `caches-layer` — clustered marker symbol.
  - `landuse-src` / `landuse-layer` — semi-transparent polygons, kind-colored.
  - `tour-src` / `tour-layer` — line layer, width-by-zoom.
  - `parking-src` / `parking-layer` — single marker with custom icon (Material Symbols, never Groundspeak).
- **Score breakdown panel** is always visible after planning. Each row: constraint name, weight, contribution, sign.

## 8. Conventions

- **Naming.** `kebab-case` filenames; `PascalCase` for React components and Nest classes; `camelCase` for variables.
- **Errors.** API throws Nest exceptions; web surfaces user-readable messages via a single error boundary + toast.
- **Logging.** Pino in the API; emits JSON in production, pretty in dev. Never log full GPX bodies or cache descriptions.
- **Migrations.** One SQL file per change, never edit a merged migration. Indexes added in the same migration as the column they support.
- **Tests.** Co-located in `*.spec.ts` / `*.test.ts` next to the unit under test; integration tests in `apps/api/test/integration/`; E2E in `apps/web/e2e/`.

## 9. Open design questions (deferred)

- **Driving / cycling profiles.** Not MVP; would need an OSRM container per profile (or osrm-routed multi-profile setup).
- **Multi-day tours.** Out of scope until the single-day UX is loved.
- **Heuristic-vs-solver thresholds.** Need real-world data on cluster sizes and constraint counts before promoting `SolverTourPlanner`.
- **Tile hosting.** Default tile source TBD — pick something whose ToS allows our scale and license. Document in `LICENSING.md` once chosen.
