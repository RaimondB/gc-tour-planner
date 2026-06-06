# Auth + saved tours + sharing (M6)

Concrete design for M6. _What_ lives in [../requirements/persistence-sharing.md](../requirements/persistence-sharing.md); _why_ for the session and sharing models lives in [ADR-0021](../adr/0021-auth-and-session-strategy.md) and [ADR-0022](../adr/0022-tour-sharing-link-security.md). Tables here extend [data-model.md](data-model.md); endpoint shapes feed [api-surface.md](api-surface.md); module placement is in [../architecture/backend.md](../architecture/backend.md).

## 1. Scope

Three capabilities, four shipping sub-phases (M6-α…δ): authentication (local + Google OAuth), saved tours, read-only sharing links. The `users` table already exists from the init migration; per-user isolation is already enforced in every repository via `owner_id`. M6 replaces only the request-user source — today's `DevUserMiddleware` — with a real guard. The `@CurrentUser()` decorator and `AuthUser = { id, email, displayName }` contract are unchanged.

## 2. Session strategy (the central decision — ADR-0021)

FR-P4 originally specified "JWT in httpOnly cookie". Valkey is already a load-bearing dependency ([ADR-0004](../adr/0004-valkey-over-redis.md)), which opens a second option. The cookie + CSRF + guard surface is identical either way; only the guard's verify step differs.

| | Valkey-backed sessions (recommended) | Stateless JWT in cookie |
| --- | --- | --- |
| Logout / revocation | Instant — delete the session key | Awkward — short TTL + denylist |
| "Log out everywhere" | Trivial | Needs token versioning |
| Per-request cost | One Valkey read (cheap; already in the throttling hot path) | Zero store hit — pure signature verify |
| Scale to N replicas | Fine — shared Valkey | Trivial — nothing shared |
| Secret rotation | Sessions survive | Rotating the key invalidates all sessions |
| Complexity | Session store + sliding expiry | Refresh-token rotation |

**Recommendation:** Valkey-backed sessions — FR-P6 (logout) and FR-P7 (revocation) are materially cleaner and Valkey is already present. If stateless JWT is chosen instead, the only schema delta is "no session store / optional denylist table." ADR-0021 records the final call.

## 3. Token / session contents, TTL, refresh

- Claims / session value: `sub` (user id), `email`, `iat`, `exp`.
- Access lifetime short (≈ 15 min) with sliding extension; a longer refresh/sliding window (≈ 30 days) carried in a separate httpOnly cookie (stateless) or as the session TTL (Valkey).
- On 401 the client attempts one silent refresh; failing that, it redirects to `/login` (FR-P7).
- Signing: HS256 with `AUTH_SESSION_SECRET` (env-only) via `jose`. Rotation policy noted in ADR-0021.

## 4. CSRF

Double-submit cookie (stateless, fits the `SameSite=Lax` defense-in-depth posture): a non-httpOnly `csrf` cookie is read by the client and echoed in an `X-CSRF-Token` header; the server compares the two. Required on all state-changing methods (POST/PATCH/DELETE). Exempt: every `GET`, plus `GET /shared/:slug` and `GET /auth/me`. `SameSite=Lax` already blocks cross-site POST; the token is belt-and-suspenders (NFR-11).

## 5. Password hashing

argon2id via the `argon2` npm package (MIT). Starting parameters: `memoryCost` ≈ 19 MiB, `timeCost` ≈ 2, `parallelism` = 1 — tuned to ~50–100 ms on target hardware (NFR-10). Chosen over bcrypt for memory-hardness. Per FR-P5: min 10 chars, reject common/breached passwords, no composition rules, accept ≥ 128.

## 6. Google OAuth

Authorization-code flow, shipped in M6-α.

- Redirect URIs are configured per environment generically — no real hostnames in the repo (CLAUDE.md hard rule). The web origin and callback path come from env (`OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_GOOGLE_REDIRECT_URI`).
- A signed `state` parameter protects the round-trip.
- **Account linking by verified email:** if the Google profile's verified email matches an existing `users.email`, the sign-in links to that account; otherwise it creates an OAuth-only user (`password_hash IS NULL` — already supported by the schema).
- **No Google access/refresh tokens are persisted** (NFR-10, and the "no third-party creds in DB" hard rule). We keep project identity only.
- Library: prefer the lightweight `openid-client` + `jose` route over full `passport` to minimise surface; `passport-google-oauth20` (MIT) is the fallback. License-vet whichever lands and record it in [../LICENSING.md](../LICENSING.md).

## 7. Guard swap + public-endpoint inventory

`DevUserMiddleware` → a global `JwtAuthGuard`. Everything is authenticated by default; `@Public()` exempts only the routes in the table below. The dev/e2e bypass stays behind `AUTH_DEV_BYPASS=1`, hard-refused under `NODE_ENV=production` (mirroring the existing middleware's production throw), so Playwright e2e and local dev can attribute requests to a seeded user without a login round-trip.

This table is a **normative security contract**: adding a `@Public()` route requires updating it (and [FR-P11](../requirements/persistence-sharing.md)) in the same PR, and an integration test asserts the live `@Public()` set matches it.

| Public route | Why public | Guardrails |
| --- | --- | --- |
| `POST /auth/register` | Can't be logged in to sign up | Rate-limited per-IP + email (FR-P9); generic errors; password rules (FR-P5) |
| `POST /auth/login` | Establishes the session | Rate-limited; argon2 verify; generic "invalid credentials" |
| `GET /auth/google`, `GET /auth/google/callback` | OAuth entry + provider return | Signed `state`; link only by verified email; no Google tokens stored |
| `GET /shared/:slug` | Anonymous read-only shared tour (FR-P3) | Snapshot only; no owner identity / other tours; read-only; revocable |
| `/health` | Liveness probe | No data |

**Explicitly NOT public** (require a valid session): `GET /auth/me`, `POST /auth/logout`, and `POST`/`DELETE /tours/:id/share` (share _management_ stays owner-auth; only the `GET /shared/:slug` _read_ is public). Every other endpoint requires auth (FR-P12).

## 8. Tours persistence schema & migration

The `tours` table is designed in [data-model.md](data-model.md) but not yet migrated. M6-γ adds a new migration (`~1779690000000_tours.sql`, one change per file) creating it as specified, **plus a `plan JSONB NOT NULL` column** holding the full `PlanResult` for a re-render-without-replan round-trip (FR-P1). The typed columns (`total_meters`, `total_seconds`, `score_breakdown`, `cache_ids`, `geom`) back listing/sorting and spatial queries. The `UNIQUE` constraint on `share_slug` already provides the slug-lookup index; `tours_owner_idx` backs the per-user list. Regenerate Kysely types after the migration (per [../sdlc/migrations.md](../sdlc/migrations.md)).

If Valkey-backed sessions are chosen, there is **no** sessions table — sessions live in Valkey. Only the stateless-JWT-with-denylist variant would add a table; ADR-0021 records which.

## 9. Sharing-link slug

16-char base32 derived from `crypto.randomBytes(10)` (~80 bits) — opaque, non-sequential, carrying no owner or tour-id information. On the rare unique-constraint collision, retry generation. Revoke nulls the column; re-share mints a fresh slug, so old links stay dead (FR-P3.4, ADR-0022).

## 10. Public read-only endpoint (`GET /shared/:slug`)

Returns a `SharedTour` DTO assembled from the tour's stored snapshot:

```ts
type SharedTour = {
  name: string;
  totalMeters: number;
  totalSeconds: number;
  scoreBreakdown: ScoreBreakdown;
  geom: GeoJsonLineString; // the routed polyline
  parking: GeoJsonPoint | null;
  caches: Array<{
    // snapshot, not a live owner-scoped read
    id: number;
    code: string;
    type: string;
    name: string;
    location: GeoJsonPoint;
  }>;
};
```

It exposes **no** owner id/email/display name, **no** other tours, and performs **no** owner-scoped cache reads — the cache list is denormalised into the tour at save time so the public view neither leaks the live caches table nor breaks when a cache is later deleted (ADR-0022).

## 11. API surface additions

| Method + path | Auth | CSRF | Notes |
| --- | --- | --- | --- |
| `POST /auth/register` | public | — | Self-service (FR-P5) |
| `POST /auth/login` | public | — | Sets session + `csrf` cookies |
| `POST /auth/logout` | session | yes | Clears cookies (+ deletes Valkey session) |
| `GET /auth/me` | session | — | Backs the web auth context |
| `GET /auth/google` → `GET /auth/google/callback` | public | — | OAuth (FR-P4.3) |
| `POST /tours` | session | yes | Save a `PlanResult` (FR-P1) |
| `GET /tours` | session | — | Owner-scoped summaries (FR-P2) |
| `GET /tours/:id` | session | — | Full detail; cross-tenant → 404 |
| `PATCH /tours/:id` | session | yes | Rename |
| `DELETE /tours/:id` | session | yes | Delete (revokes any share) |
| `POST /tours/:id/share` | session | yes | Mint slug (idempotent) |
| `DELETE /tours/:id/share` | session | yes | Revoke (old URL 404s) |
| `GET /shared/:slug` | public | — | Read-only snapshot (FR-P3, §10) |

Shared zod schemas in `packages/shared`: `RegisterInput`, `LoginInput`, `AuthUser`, `SaveTourInput`, `SavedTourSummary`, `SavedTourDetail`, `SharedTour`. The detailed bodies are recorded in [api-surface.md](api-surface.md).

## 12. Frontend integration

- **Router (first in the app):** TanStack Router pairs with the existing TanStack Query and is fully typed. Today's whole `App.tsx` becomes the protected `/` route; public routes are `/login`, `/register`, and `/shared/:slug`.
- **Auth context:** an `AuthProvider` exposing `useAuth()`, backed by a `GET /auth/me` query; protected routes redirect to `/login` when unauthenticated.
- **`api.ts`:** add `credentials: "include"`; read the `csrf` cookie and send it as `X-CSRF-Token` on mutating calls; a central interceptor maps 401 → redirect to `/login`.
- **Shared view:** the public `/shared/:slug` route renders a stripped-down read-only map reusing `MapView`/`TourLayer`/`CachesLayer` with no edit/save affordances.
- **Out of scope for M6:** forgot-password and email verification (need email-sending infra) — deferred.
