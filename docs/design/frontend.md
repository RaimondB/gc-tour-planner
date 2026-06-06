# Frontend implementation notes

- **TanStack Query keys** mirror endpoint shape: `['caches', { center, radiusM, types, attributes, contexts }]`. Layer-specific keys include the snapped viewport bbox so a small pan inside a tile doesn't bust the cache (see `useViewportBbox` below).
- **State persistence.** Three pieces persist to `localStorage` via `useLocalStorageState` ([apps/web/src/lib/persistent-state.ts](../../apps/web/src/lib/persistent-state.ts)) so a hard refresh restores the user's spot:
  - `gctp:search` — filter sidebar (center, radius, types, contexts, excludeFound).
  - `gctp:plan-settings` — planner sidebar (start mode, OSM-parking filters, link cap, budgets, fringe trim, topN).
  - `gctp:viewport` — map center + zoom (decoupled from `params.center` so panning around to browse doesn't churn the search).
- **Viewport-following data layers.** [apps/web/src/features/map/useViewportBbox.ts](../../apps/web/src/features/map/useViewportBbox.ts) listens to `moveend`, debounces, snaps the bbox to a fixed lat/lng grid + pads by one cell, and exposes it as React state. Three layers consume it (Landuse, OsmParking, WalkingGraph). Below each layer's `minZoom` the hook returns `null` — the layer's render effect then sets its GeoJSON source to an empty FeatureCollection so the previously-fetched data is cleared (otherwise a zoomed-out view would still render the snapshot from the zoomed-in fetch).
- **Map layers** (MapLibre source/layer ids):
  - `gctp-caches` / `gctp-caches-circle` — typed circle markers, radius interpolated by zoom (z9→4 px / z14→9 px).
  - `gctp-landuse` / `-fill` / `-line` — semi-transparent polygons, kind-coloured. Viewport-following, z8+.
  - `gctp-osm-parking` / `-fill` / `-line` / `-point` / `-label` — ADR-0011 OSM parking. Polygons + node circles + `P` / `P€` text labels, styled by access + fee. Viewport-following, z `PARKING_MIN_ZOOM` (currently 12) and above. Click → popup with raw OSM tags.
  - `gctp-parking-circle` — cache-owner parking (`additional_waypoints.type='parking'`). Shares `PARKING_MIN_ZOOM` with `OsmParkingLayer` via [apps/web/src/features/map/parking-zoom.ts](../../apps/web/src/features/map/parking-zoom.ts), sized smaller than the cache circle so the cache stays the headline feature.
  - `gctp-parking-preview-*` — ADR-0011 walking previews per cluster (dashed lines, red = bogus = exceeded `maxLinkMeters`, blue = OK).
  - `gctp-parking-owner-link-line` — yellow dotted straight line from any clicked parking marker to the cache that listed it.
  - `gctp-tour-*` — chosen-plan polyline + numbered visit pins + dropped-cache `x` badges. `triggerRepaint()` is called after every source mutation because MapLibre otherwise skips the redraw when the map is quiescent.
  - `gctp-walking-graph-*` — debug overlay (planner sidebar toggle).
- **`ZoomDebugBadge`** ([apps/web/src/features/map/ZoomDebugBadge.tsx](../../apps/web/src/features/map/ZoomDebugBadge.tsx)) renders a small bottom-left overlay with the current zoom + center coords for tuning per-layer thresholds without DevTools.
- **Score breakdown panel** is always visible after planning. Each row: constraint name, weight, contribution, sign.
- **Auth + routing (M6).** TanStack Router is introduced for the first time: public routes `/login`, `/register`, `/shared/:slug` vs. the protected `/` (today's `App.tsx`). An `AuthProvider` exposes `useAuth()`, backed by a `['auth','me']` query over `GET /auth/me`; protected routes redirect to `/login` when unauthenticated. `api.ts` gains `credentials: "include"`, reads the non-httpOnly `csrf` cookie and sends it as `X-CSRF-Token` on POST/PATCH/DELETE, and a central interceptor maps 401 → `/login`. The `/shared/:slug` view reuses `MapView`/`TourLayer`/`CachesLayer` read-only (no edit/save). See [auth-and-sharing.md](auth-and-sharing.md).
