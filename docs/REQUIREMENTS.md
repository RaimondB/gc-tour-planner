# Requirements

Source-of-truth for what gc-tour-planner must do. Changes here are normative; design choices live in [DESIGN.md](DESIGN.md) and ADRs.

## 1. Problem statement

A geocacher planning a day out wants to:

1. Pick an area (home, hotel, trailhead).
2. Find geocaches in that area that match their interests (cache type, attributes, terrain difficulty).
3. Prefer caches in pleasant surroundings (forest, park) over urban filler.
4. Walk a **closed loop** that visits as many of those caches as possible within a distance / time budget.
5. Start and finish at a sensible **parking spot** — ideally one recommended by the cache owner (Groundspeak "Parking Area" waypoints), otherwise a nearest-road point.

Existing tools each solve one slice (filtering, mapping, basic routing). None combines cluster discovery + landuse-aware preferences + walking-route TSP + parking-aware loop framing.

## 2. Personas

- **Owner-maintainer (you).** Plans personal tours, runs the stack locally or on a small VPS.
- **Tour planner (logged-in user).** Uploads their own Pocket Query GPX, plans and saves tours, optionally shares read-only links.
- **Tour viewer (anonymous link recipient).** Opens a shared read-only tour, sees the map and cache list.

## 3. Functional requirements

### 3.1 Cache ingest

- **FR-I1.** Accept GPX upload via the web UI. Parse Groundspeak Pocket Query extensions (`groundspeak:cache`, `groundspeak:attributes`, `groundspeak:short_description`, `groundspeak:long_description`) **and** generic GPX waypoints.
- **FR-I2.** Identify and store **additional waypoints** with `type='parking'` (Groundspeak `<sym>Parking Area</sym>`) per cache.
- **FR-I3.** Upsert by `(source, source_id)` so re-uploading a refreshed PQ updates instead of duplicating.
- **FR-I4.** Per-user row-level isolation: a user only sees caches they uploaded (or that came from a public source adapter).
- **FR-I5 (M7).** Optional **OKAPI** source adapter for OpenCaching nodes, queryable by bbox.
- **FR-I6 (M8, feature-flagged off).** GC.com partner-API adapter — single shared partner key from env; never per-user creds in DB.
- **FR-I7 (record finds).** The user can record which caches they have found, via two paths:
  - Uploading a Groundspeak **"My Finds"** Pocket Query GPX — every cache in the upload is also marked as found by the current user (idempotent; re-uploading does not duplicate).
  - **Manual mark / unmark** from the map popup of any cache they own. Finds are per-user; another user does not see them.

### 3.2 Filtering

- **FR-F1.** Search caches by center + radius (m).
- **FR-F2.** **Hard filter** on cache type (Traditional, Multi, Mystery, Letterbox, EarthCache, …).
- **FR-F3.** **Hard filter** on Groundspeak attributes (AND-of-OR groups, e.g. `(dog-allowed OR not-stroller) AND wheelchair-accessible`).
- **FR-F4.** Allow promoting any attribute from hard filter to **soft preference** with a positive or negative weight.
- **FR-F5.** **Soft preference** on OSM landuse kinds — predefined system profiles (e.g. "Forest hike day", "Urban evening stroll") plus user-owned custom profiles with per-kind weights.
- **FR-F6.** **Soft preference** on terrain and difficulty target values (with tolerance + weight).
- **FR-F7.** Filter results render on the map with debounced re-query as the user changes filters.
- **FR-F8 (exclude my finds).** The user can toggle a "Exclude caches I have found" filter. When enabled, every cache the current user has logged as found is omitted from results _and_ from the tour-planning pool. Found caches that are still shown (toggle off) are visually dimmed so the user can tell at a glance.

### 3.3 Tour planning

- **FR-T1.** Given (center, radius, hard filters, soft preferences, budgets), return a ranked list of **candidate clusters** suitable for a closed loop.
- **FR-T2.** For a chosen cluster, return a **planned loop**: ordered cache list, polyline along walking roads (OSRM), totals (meters, seconds, in-cache-visit time), and parking point.
- **FR-T3.** Budgets the user can set: `maxCaches` (default 15, cap 50), `distanceBudgetMeters` (default 8 000, cap 25 000), optional `timeBudgetMinutes` (using OSRM seconds + per-cache visit time, default 5 min/cache).
- **FR-T4.** Parking selection priority: (a) Groundspeak parking waypoint nearest the cluster centroid → (b) OSRM `/nearest` road point → (c) user-clicked point.
- **FR-T5.** Return a **score breakdown** per soft constraint so the user understands why the loop scored as it did.
- **FR-T6.** Tour-planning is a pluggable strategy — see [ADR-0002](adr/0002-planner-strategy-interface.md). MVP ships `GreedyTspPlanner` (DBSCAN → NN+2-opt); solver-based strategies plug in later.

### 3.4 Persistence + sharing (M6)

- **FR-P1.** Authenticated users can **save** a planned tour (name, cache ids, start/parking, totals, geom, score breakdown).
- **FR-P2.** Saved tours list per user; open / rename / delete.
- **FR-P3.** Generate a **read-only sharing link** (opaque slug) — anonymous viewer can see map + list without auth.
- **FR-P4.** Auth: email + argon2 password **and** Google OAuth. JWT in httpOnly SameSite=Lax cookie + CSRF token.

### 3.5 Map UI

- **FR-M1.** MapLibre GL JS map with cache markers (clustered at low zoom), landuse polygon overlay (toggle), planned tour polyline, parking marker.
- **FR-M2.** Collapsible filter sidebar; map and sidebar always reflect the same query state.
- **FR-M3.** Display OSM attribution ("© OpenStreetMap contributors") on every map view.
- **FR-M4.** Attribute icons must be free-license (Material Symbols / text chips) — **never** bundle Groundspeak's copyrighted icons.
- **FR-M5 (search radius visible on map).** Render the current search radius as a non-interactive circle overlay around the active search center. The overlay updates immediately as the user changes the center or the radius.
- **FR-M6 (set center by clicking the map).** A single left-click anywhere on the map sets the search center to that point. Sidebar inputs reflect the new value; the camera does **not** jump (the user already chose the location visually).
- **FR-M7 (geolocate flies the camera).** Activating **Use my location** updates the search center _and_ flies the camera there at a sensible zoom (≈ radius-fitting). Sidebar inputs reflect the new value.
- **FR-M8 (decimal-dot lng/lat inputs).** Longitude and latitude inputs always display and accept `.` as the decimal separator, regardless of browser locale. (Comma input is also accepted as a convenience and normalized on commit.)

## 4. Non-functional requirements

- **NFR-1 (Type safety).** Shared zod schemas between client and server (`packages/shared`); no duplicated DTO definitions.
- **NFR-2 (Reproducible dev env).** `cp .env.example .env && docker compose up --build` brings the full stack up (postgres+postgis, valkey, osrm, api, web, jobs). First boot may take ~10 minutes for OSRM preprocessing — subsequent boots are fast.
- **NFR-3 (Performance).** Filtered cache search over 10 000 caches in a 25 km radius returns in < 500 ms on developer hardware (PostGIS GIST index + clustered indexes).
- **NFR-4 (Determinism).** The greedy planner is deterministic for a fixed input (no random tie-breaks).
- **NFR-5 (License compliance).** All runtime + build dependencies must be GPLv3-compatible. CI runs a license checker that fails on incompatible licenses. See [LICENSING.md](LICENSING.md) and [ADR-0003](adr/0003-license-gplv3.md).
- **NFR-6 (Data ownership).** User-uploaded GPX is per-owner row-level isolated; no global cross-user leakage of Groundspeak data.
- **NFR-7 (Testability).** Unit tests for pure functions (GPX parsing, TSP, clustering, filter SQL builder); integration tests with real PostGIS via Testcontainers; Playwright E2E exercises the upload → plan → save loop.
- **NFR-8 (International).** No NL-only assumptions in schema, APIs, or UX. The OSRM region is configurable; the user chooses which extract to preprocess.

## 5. Out of scope (MVP)

- Driving / cycling routing (foot profile only).
- Mobile app (responsive web is enough).
- Multi-day tours.
- Crowd-sourced "tour quality" ratings.
- Realtime cache-status updates.

## 6. Roadmap

| Phase  | Contents                                                                                                                                                                | Status                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **M1** | Foundations: monorepo scaffold, docs + ADRs, agent instructions, NestJS+Vite skeletons, docker-compose (postgres+valkey), CI, `TourPlannerStrategy` interface skeleton. | _in progress (docs sub-phase first)_ |
| **M2** | Cache ingest: caches schema + migrations, GPX upload + parser, list endpoint with hard filters, basic map markers.                                                      | pending                              |
| **M3** | OSM context + radius search: Overpass client + `osm_landuse` cache, `ST_Contains` filter, sidebar UI.                                                                   | pending                              |
| **M4** | Routing infra: OSRM container + extract bootstrap, `routing` module with cached legs, OD distance matrix.                                                               | pending                              |
| **M5** | Tour planning: DBSCAN, TSP via NN+2-opt, parking selection, `/tours/plan` + UI.                                                                                         | pending                              |
| **M6** | Persistence + multi-user: auth, saved tours, read-only sharing links.                                                                                                   | pending                              |
| **M7** | OKAPI source adapter.                                                                                                                                                   | pending                              |
| **M8** | GC.com adapter (gated on partner approval; feature-flagged off).                                                                                                        | pending                              |

## 7. Acceptance — end-to-end smoke (post-M6)

1. `cp .env.example .env && docker compose up --build` — wait for OSRM preprocessing.
2. Open `http://localhost:5173`, register, log in.
3. Drag-drop a sample Groundspeak PQ GPX (≥ 50 caches).
4. Set center to a known cluster, radius 5 km. Hard filter type ∈ {Traditional, Multi} and attribute = "Dog allowed". Soft-prefer system profile "Forest hike day".
5. Verify map shows hard-filtered caches and the landuse toggle reveals polygons; forest caches score higher.
6. Click **Plan loop** with `maxCaches=20`, `distanceBudgetMeters=12 000`, `timeBudgetMinutes=240`.
7. Verify the result: closed polyline ≤ 12 km, ≤ 4 h, ≤ 20 caches; parking marker (PQ-provided preferred); score breakdown panel shown.
8. Save the tour. Reload the page. Tour and the chosen landuse profile re-render from the DB.
9. CI is green: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm licenses:check`.
10. `docs/REQUIREMENTS.md`, `ARCHITECTURE.md`, `DESIGN.md`, `LICENSING.md`, and `CLAUDE.md` are present and current.
