# Data flow — happy paths

How requests traverse the stack from the user action down to storage and back.

## Upload → render

1. User drags a GPX file → `POST /gpx/upload` (multipart).
2. API: `gpx` service streams the file into the shared parser; upserts `caches` + `additional_waypoints`, scoped to `req.user.id`.
3. Web invalidates the `/caches` query → markers re-render.

## Filter → list

1. Sidebar updates filter state → debounced → `GET /caches?center&radiusM&types&attributes`.
2. API: `caches` repository runs `ST_DWithin` + type/attribute joins → returns rows + `clustersHint`.
3. Web sets the marker layer's GeoJSON source.

## Plan loop

1. User clicks "Plan loop" → `POST /tours/plan` with budgets + soft preferences.
2. API: `tours` service hands off to the injected `TourPlannerStrategy.plan(input)`.
3. Strategy (greedy MVP):
   1. PostGIS query for hard-filter-satisfying caches in radius.
   2. DBSCAN clusters (ε adapted to budget).
   3. Score clusters; pick top.
   4. Greedy admission → OD matrix via `routing.getMatrix` → 2-opt loop.
   5. Pick parking by `startPreference`.
4. Returns `PlanResult` → web renders polyline + parking marker + score breakdown panel.

## Save tour (M6)

1. User clicks "Save" → `POST /tours` with the previously-returned `PlanResult`.
2. API: `tours` service inserts into `tours`, scoped to `req.user.id`. Generates an opaque sharing slug.
3. Web shows the saved tour in "My tours".
4. Anonymous viewer hits `GET /tours/share/:slug` → read-only payload (no cache attribute weights, no profile internals).
