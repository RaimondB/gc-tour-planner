# Requirements

Source-of-truth for what gc-tour-planner must do. Changes here are normative; design choices live in [../design/](../design/index.md) and ADRs.

## Parts

- [Ingest](ingest.md) — GPX upload, source adapters, find tracking (FR-I*)
- [Filtering](filtering.md) — hard filters, soft preferences, exclude-found (FR-F*)
- [Tour planning](tour-planning.md) — cluster discovery, routed loop, parking, warm cache (FR-T*)
- [Persistence + sharing](persistence-sharing.md) — saved tours, sharing links, auth (FR-P*) — M6
- [Map UI](map-ui.md) — MapLibre map, sidebar, attribution (FR-M*)
- [Non-functional](non-functional.md) — performance, determinism, license, ownership (NFR-*)
- [Out of scope](out-of-scope.md) — what we explicitly are not building (MVP)
- [Roadmap](roadmap.md) — milestones M1–M8 with status
- [Acceptance](acceptance.md) — end-to-end smoke test post-M6

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
