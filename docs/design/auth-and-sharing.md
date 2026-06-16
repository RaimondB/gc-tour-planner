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

**Decision (ADR-0021): Valkey-backed sessions.** FR-P6 (logout) and FR-P7 (revocation) are materially cleaner and Valkey is already present. This supersedes FR-P4's original "JWT in cookie" wording; there is no sessions table (§8). The stateless-JWT column is retained above only as the documented alternative.

## 3. Token / session contents, TTL, refresh

- Claims / session value: `sub` (user id), `email`, `iat`, `exp`.
- Access lifetime short (≈ 15 min) with sliding extension; a longer refresh/sliding window (≈ 30 days) carried in a separate httpOnly cookie (stateless) or as the session TTL (Valkey).
- On 401 the client attempts one silent refresh; failing that, it redirects to `/login` (FR-P7).
- Session id is an opaque random token; the Valkey value holds the claims above. (`jose`/HS256 signing applies only to the refresh token and the OAuth `state`, signed with `AUTH_SESSION_SECRET`, env-only.)

**M6-α implementation note.** The shipped backend uses the **single sliding-TTL Valkey session** variant: one opaque `sid` cookie whose Valkey key carries the claims + the bound CSRF token, with the TTL refreshed on every authenticated request (default 30 days, `AUTH_SESSION_TTL_SECONDS`). There is no separate stateless refresh token — the sliding session window subsumes it, and `jose` is therefore used **only** to sign/verify the OAuth `state`. Logout deletes the key (instant revocation). The 401→silent-refresh client behaviour (FR-P7) is satisfied because activity slides the window.

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
- Library: prefer the lightweight `openid-client` + `jose` route over full `passport` to minimise surface; `passport-google-oauth20` (MIT) is the fallback. License-vet whichever lands and record it in [../LICENSING.md](../LICENSING.md). **M6-α shipped with neither** — the flow is implemented directly with `jose` (sign/verify the `state`; verify Google's `id_token` against its JWKS) + native `fetch` for the token exchange, the most minimal GPLv3-compatible surface. No access/refresh tokens are stored.

## 7. Guard swap + public-endpoint inventory

`DevUserMiddleware` → a global `JwtAuthGuard`. Everything is authenticated by default; `@Public()` exempts only the routes in the table below. The dev/e2e bypass stays behind `AUTH_DEV_BYPASS=1`, hard-refused under `NODE_ENV=production` (mirroring the existing middleware's production throw), so Playwright e2e and local dev can attribute requests to a seeded user without a login round-trip.

This table is a **normative security contract**: adding a `@Public()` route requires updating it (and [FR-P11](../requirements/persistence-sharing.md)) in the same PR, and an integration test asserts the live `@Public()` set matches it.

| Public route | Why public | Guardrails |
| --- | --- | --- |
| `POST /auth/register` | Can't be logged in to sign up | Rate-limited per **real client IP** + email (FR-P9); **Turnstile captcha when configured** (§7c); generic errors; password rules (FR-P5) |
| `POST /auth/login` | Establishes the session | Rate-limited; argon2 verify; generic "invalid credentials" |
| `GET /auth/google`, `GET /auth/google/callback` | OAuth entry + provider return | Signed `state`; link only by verified email; no Google tokens stored |
| `GET /shared/:slug` | Anonymous read-only shared tour (FR-P3) | Snapshot only; no owner identity / other tours; read-only; revocable |
| `/health` | Liveness probe | No data |

**Explicitly NOT public** (require a valid session): `GET /auth/me`, `POST /auth/logout`, and `POST`/`DELETE /tours/:id/share` (share _management_ stays owner-auth; only the `GET /shared/:slug` _read_ is public). Every other endpoint requires auth (FR-P12).

### 7a. Admin role (FR-P12)

`/admin/*` and the destructive `POST /tours/walking-graph/purge-bogus` require the **admin role**, not merely a session. The `users.is_admin` column (added by `1779700000000_users_is_admin.sql`, default `FALSE`) is captured into the session at login and carried on `AuthUser.isAdmin`; an `AdminGuard` (a route guard layered after the global `JwtAuthGuard`) returns 403 for non-admins and **fails closed** (a legacy session with no `isAdmin` field is treated as non-admin). No user is an admin until an operator promotes one: `UPDATE users SET is_admin = TRUE WHERE email = '<operator>'`.

The **bull-board** queue dashboard (`/admin/queues`) is mounted as raw Express middleware *outside* Nest's routing, so the global guard never runs for it. A dedicated `requireAdminSession` middleware (mirroring `AdminGuard`) authenticates the session and requires `isAdmin` before the dashboard router — closing what was an unauthenticated admin surface.

### 7b. Rate-limit client-IP keying (FR-P9)

The per-IP throttle on the credential endpoints keys on the **real client IP**, resolved behind the reverse proxy:

- Express `trust proxy` is set (env `TRUST_PROXY`, default `1` = the immediate nginx hop) so `req.ip` is the client, not nginx's socket address. nginx appends the true peer to `X-Forwarded-For`, so an inbound spoofed `X-Forwarded-For` cannot win.
- The throttler's `getTracker` prefers Cloudflare's `CF-Connecting-IP` (env `TRUST_CF_CONNECTING_IP`, default on) **while the CF tunnel is the only ingress** — CF sets it and clients can't forge it. Once the origin is directly reachable (tunnel removed), set `TRUST_CF_CONNECTING_IP=0` so the spoofable header is ignored and keying falls back to `trust proxy`/`req.ip`.

Without this the throttle keyed on nginx's socket IP — collapsing every client into a single shared bucket.

### 7c. Registration captcha (FR-P5, Gate 1.4)

`POST /auth/register` is and stays `@Public()` (you can't be logged in to sign up), but once Cloudflare Access is removed it becomes internet-facing. Rate limits alone don't stop scripted mass-registration — the per-email cap is trivially defeated with `user+1@`, `user+2@`… aliases. A **Cloudflare Turnstile** human-verification challenge closes that gap ([ADR-0023](../adr/0023-staged-cloudflare-access-tunnel-removal.md) Gate 1.4).

- **Server (`TurnstileService`, `apps/api/src/auth/turnstile.service.ts`).** When `TURNSTILE_SECRET` is set, the controller verifies the client's token against Cloudflare's `siteverify` endpoint (passing the real client IP as `remoteip`) **before** creating the account. A missing token → 400; a failed challenge → 403; an unreachable `siteverify` → 503 (**fail closed** — never wave a registration through).
- **Client (`TurnstileWidget`, `apps/web`).** When the build-time `VITE_TURNSTILE_SITE_KEY` is set, the register form renders the Turnstile widget, keeps the submit button disabled until it's solved, and sends the token in the `turnstileToken` body field. The widget loads from Cloudflare (no bundled/managed asset, so no GPLv3 concern) and is remounted to re-challenge after a failed submit (tokens are single-use).
- **Disabled by default.** With no secret configured the check is a no-op, so dev / local / Playwright e2e keep open registration. The operator **MUST** configure both env vars before removing Cloudflare Access. The site key is public by design (it ships in the static bundle); only the secret is sensitive and stays out of the repo.
- `RegisterInput` is unchanged — the captcha token rides alongside the account fields and is stripped by the zod parse; verification is a controller concern, not part of the account-data contract.

## 8. Tours persistence schema & migration

The `tours` table is designed in [data-model.md](data-model.md). M6-γ adds the migration (`packages/db/migrations/1779730000000_tours.sql`, one change per file — the timestamp follows the last applied migration so it doesn't run out of order) creating it as specified, **plus a `plan JSONB NOT NULL` column** holding [`StoredPlan`](../../packages/shared/src/tours/stored-plan.ts) — the full `PlanResult` **plus** a denormalised cache snapshot (`{ id, code, type, name, location }` per ordered cache) — for a re-render-without-replan round-trip (FR-P1) and so the public shared view (M6-δ) never reads owner-scoped cache tables (ADR-0022). The typed columns (`total_meters`, `total_seconds`, `score_breakdown`, `cache_ids`, `geom`) are **derived server-side from the `PlanResult`** and back listing/sorting and spatial queries. The `UNIQUE` constraint on `share_slug` already provides the slug-lookup index; `tours_owner_idx` backs the per-user list. Kysely types are hand-maintained in `packages/db/src/schema.ts` (per [../sdlc/migrations.md](../sdlc/migrations.md)).

There is **no** sessions table — sessions live in Valkey (ADR-0021). (The stateless-JWT-with-denylist alternative, not adopted, would have been the only variant needing one.)

## 9. Sharing-link slug

16-char base32 derived from `crypto.randomBytes(10)` (~80 bits) — opaque, non-sequential, carrying no owner or tour-id information. On the rare unique-constraint collision, retry generation. Revoke nulls the column; re-share mints a fresh slug, so old links stay dead (FR-P3.4, ADR-0022).

## 10. Public read-only endpoint (`GET /shared/:slug`)

Returns a `SharedTour` DTO assembled **only** from the snapshot denormalised into the tour's `plan` JSONB at save time. Totals only — **no `scoreBreakdown`** and no other soft-preference internals (ADR-0022 #4):

```ts
type SharedTour = {
  name: string;
  totalMeters: number;
  totalSeconds: number;
  // no scoreBreakdown — stripped from the public payload (ADR-0022 #4)
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

It exposes **no** owner id/email/display name, **no** other tours, **no** score breakdown, and performs **no** owner-scoped cache reads — the cache list is denormalised into the tour's `plan` JSONB at save time, so the public view neither leaks the live caches table nor breaks when a cache is later deleted (ADR-0022). The endpoint is not rate-limited: the ~80-bit slug is unguessable.

## 11. API surface additions

| Method + path | Auth | CSRF | Notes |
| --- | --- | --- | --- |
| `POST /auth/register` | public | — | Self-service (FR-P5); Turnstile token in body when configured (§7c) |
| `POST /auth/login` | public | — | Sets session + `csrf` cookies |
| `POST /auth/logout` | session | yes | Clears cookies (+ deletes Valkey session) |
| `POST /auth/password` | session | yes | Set/change own password (FR-P5a). Current password required + verified only when one already exists; OAuth-only accounts set their first without it. Per-email rate-limited. |
| `GET /auth/me` | session | — | Backs the web auth context |
| `GET /auth/google` → `GET /auth/google/callback` | public | — | OAuth (FR-P4.3) |
| `POST /tours` | session | yes | Save a `PlanResult` (FR-P1) |
| `GET /tours` | session | — | Owner-scoped summaries (FR-P2) |
| `GET /tours/:id` | session | — | Full detail; cross-tenant → 404 |
| `PATCH /tours/:id` | session | yes | Rename |
| `DELETE /tours/:id` | session | yes | Delete (revokes any share) |
| `PUT /tours/:id/preview` | session | yes | Store the WebP map snapshot (FR-W4); owner-scoped, ≤512 KB |
| `GET /tours/:id/preview` | session | — | Read the snapshot; cross-tenant/none → 404 (FR-W4) |
| `POST /tours/:id/share` | session | yes | Mint slug (idempotent) |
| `DELETE /tours/:id/share` | session | yes | Revoke (old URL 404s) |
| `GET /shared/:slug` | public | — | Read-only snapshot (FR-P3, §10) |

Shared zod schemas in `packages/shared`: `RegisterInput`, `LoginInput`, `SetPasswordInput`, `AuthUser`, `SaveTourInput`, `SavedTourSummary`, `SavedTourDetail`, `SharedTour`. The detailed bodies are recorded in [api-surface.md](api-surface.md).

## 12. Frontend integration

- **Router (first in the app):** TanStack Router pairs with the existing TanStack Query and is fully typed. Today's whole `App.tsx` becomes the protected `/` route; public routes are `/welcome` (marketing landing), `/login`, `/register`, and `/shared/:slug`.
- **Auth context:** an `AuthProvider` exposing `useAuth()`, backed by a `GET /auth/me` query; protected routes redirect to `/login` when unauthenticated.
- **`api.ts`:** add `credentials: "include"`; read the `csrf` cookie and send it as `X-CSRF-Token` on mutating calls; a central interceptor maps 401 → redirect to `/login`.
- **Shared view:** the public `/shared/:slug` route renders a stripped-down read-only map reusing `MapView`/`TourLayer`/`CachesLayer` with no edit/save affordances.
- **Out of scope for M6:** forgot-password and email verification (need email-sending infra) — deferred.

**M6-β implementation note.** The auth frontend shipped as described, with these specifics:

- **Router (code-based, not file-based).** `apps/web/src/router.tsx` builds the tree with `createRootRouteWithContext<{ auth }>()` + `createRoute`, avoiding the file-route generator/Vite plugin. Routes: `/` (protected, renders today's `App`), `/welcome` (public landing), `/login`, `/register`. The `/shared/:slug` public route is deferred to **M6-δ** (its `GET /shared/:slug` endpoint doesn't exist until then).
- **Guard.** The `/` route's `beforeLoad` throws `redirect({ to: "/welcome" })` when `context.auth.isAuthenticated` is false — anonymous visitors land on the public marketing page (`features/landing/LandingPage.tsx`), which carries the Sign in / Create account CTAs into `/login` and `/register`. `main.tsx` holds the router back behind a "Loading…" splash until the initial `/auth/me` probe resolves, so the guard never sees a transient anonymous state and flashes `/welcome` for an already-signed-in user. The router context's `auth` is injected per-render via `<RouterProvider context={{ auth }}>`.
- **Auth context.** `AuthProvider` (`features/auth/AuthProvider.tsx`) exposes `useAuth()` backed by a `GET /auth/me` React Query (`["auth","me"]`, `retry: false` — a `null`/logged-out answer is valid, not an error). `login`/`register` write the returned `AuthUser` into the query cache; `logout` clears it and `invalidateQueries()` to drop the previous user's owner-scoped caches.
- **`api.ts` wiring.** Every request sends `credentials: "include"`; state-changing methods echo the readable `csrf` cookie in the `X-CSRF-Token` header (double-submit, §4). A module-level `setUnauthorizedHandler` registers the central 401 → `/login` interceptor; `/auth/*` endpoints opt out so an anonymous `/auth/me` or bad-credentials `/auth/login` surfaces to the caller instead of bouncing.
- **OAuth entry** is a plain `<a href="/api/auth/google">` (a full navigation, not `fetch`) on both pages, so the browser follows the provider redirect chain.
- **UAT.** The `AUTH_DEV_BYPASS` line is removed from `infra/docker-compose.yml` now that real sign-in exists; local dev + Playwright e2e still default the bypass via `scripts/dev.sh`.
- **Testing.** Client login-flow logic (CSRF header, `credentials`, the 401 interceptor's auth-path opt-out, `fetchMe` null-on-401) is covered by `apps/web/src/lib/api.auth.test.ts`; a `@testing-library/react` component test (`features/auth/LoginPage.test.tsx`) drives the real login UI (success → redirect, bad-credentials → generic error) against a mocked `fetch` so `ApiError`/zod stay genuine. Both run under jsdom. The repo's defensive `undici@6` override (no production consumer — see `pnpm why undici`) is incompatible with jsdom 29's `undici@^7`, so a **scoped** `"jsdom>undici"` override gives jsdom a current secure `undici@7` while leaving the global pin untouched.
