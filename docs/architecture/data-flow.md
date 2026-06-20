# Data flow — happy paths

How requests traverse the stack from the user action down to storage and back.

## Upload → render

1. User drags a GPX file → `POST /gpx/upload` (multipart).
2. API: `gpx` service streams the file into the shared parser; upserts `caches` + `additional_waypoints`, scoped to `req.user.id`.
3. Web invalidates the `/caches` query → markers re-render.

### Machine ingestion (programmatic GPX upload, FR-I14 / ADR-0033)

A trusted non-browser client — a script, a scheduled job, or a future external source adapter — can feed the same pipeline without a browser session:

1. Client → `POST /ingest/gpx` (multipart `file`) with `Authorization: Bearer <INGEST_API_KEY>`.
2. `IngestAuthGuard` resolves the token → owner (the `IngestTokenResolver` seam; env key → `INGEST_OWNER_ID` today) and the controller calls the **same** `GpxService.ingest(ownerId, …)` — identical dedup, staleness guard, upsert, and precompute as the browser path.

The client and its credentials live outside this repo; GCTP exposes only the bearer-authenticated seam (off by default).

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

## Auth (M6-α/β)

1. User registers/logs in → `POST /auth/register` or `POST /auth/login`. API verifies argon2id, establishes a session (Valkey-backed per [ADR-0021](../adr/0021-auth-and-session-strategy.md)) and sets an httpOnly `SameSite=Lax` session cookie + a non-httpOnly `csrf` cookie.
2. The global `JwtAuthGuard` populates `req.user` on every subsequent request from the session cookie; `@Public()` routes skip it.
3. Web `api.ts` sends `credentials: "include"` and echoes the `csrf` cookie as `X-CSRF-Token` on mutating calls; a 401 redirects to `/login`.

## Save + share tour (M6-γ/δ)

1. User clicks "Save" → `POST /tours` with the previously-returned `PlanResult`. API: `tours` service inserts into `tours` (full `PlanResult` in `plan` JSONB + a denormalised cache snapshot), scoped to `req.user.id`.
2. Web shows the saved tour in "My tours"; `GET /tours` lists owner-scoped summaries; reopening restores from `plan` JSONB without re-planning.
3. User clicks "Share" → `POST /tours/:id/share` mints an opaque slug (idempotent). `DELETE /tours/:id/share` revokes it.
4. Anonymous viewer hits the **public** `GET /shared/:slug` → read-only snapshot payload (no owner identity, no other tours, no owner-scoped cache reads — see [ADR-0022](../adr/0022-tour-sharing-link-security.md)).
