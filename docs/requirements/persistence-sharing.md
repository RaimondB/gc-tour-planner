# Requirements — Persistence + sharing (M6)

Saved tours, read-only sharing links, authentication. All gated on M6. Concrete design lives in [design/auth-and-sharing.md](../design/auth-and-sharing.md); the _why_ for the session and sharing models is in [ADR-0021](../adr/0021-auth-and-session-strategy.md) and [ADR-0022](../adr/0022-tour-sharing-link-security.md).

M6 ships in four sub-phases (see [roadmap.md](roadmap.md)): **M6-α** auth backend, **M6-β** auth frontend, **M6-γ** save/list tours (FR-P1, FR-P2), **M6-δ** sharing links (FR-P3). The `users` table already exists from the init migration; `password_hash` is unused until M6-α. Per-user isolation is already wired end-to-end through every repository (`owner_id` / `user.id`); M6 swaps only the layer that populates the request user — today's `DevUserMiddleware` — for a real auth guard. No controller or repository signature changes.

- **FR-P1 (save a planned tour).**
  1. An authenticated `POST /tours` persists a planned tour to the `tours` table with `owner_id = current user`: name, `cache_ids`, start + parking points, totals, polyline `geom`, and `score_breakdown`. The full in-memory [`PlanResult`](../../packages/shared/src/tours/plan-result.ts) is stored verbatim in a `plan` JSONB column so the tour re-renders **without re-planning** (legs, dropped caches, parking choice all survive the round-trip); the typed columns exist for listing/sorting and spatial queries.
  2. Name is required, trimmed, 1–120 chars; validated server-side by a shared zod schema. Duplicate names are allowed (the row id is the key).
  3. A saved tour keeps its stored geometry and totals even if its referenced caches are later deleted or re-uploaded — the stored polyline renders regardless, and any cache id that no longer resolves is annotated as missing rather than breaking the view.
- **FR-P2 (list / open / rename / delete).**
  1. `GET /tours` returns the caller's tours as lean summaries (id, name, totals, cache count, `isShared`, `createdAt`), sorted `created_at desc`. Owner-scoped — never another user's tours.
  2. `GET /tours/:id` returns full detail. A cross-tenant id returns **404**, indistinguishable from "does not exist" (matching the FR-I9 isolation convention).
  3. `PATCH /tours/:id` renames (name only in M6). `DELETE /tours/:id` removes the row. Both 404 cross-tenant.
  4. Deleting a shared tour revokes its share — the slug is gone, so `GET /shared/:slug` 404s.
- **FR-P3 (read-only sharing link).**
  1. `POST /tours/:id/share` mints an opaque `share_slug` if absent and returns the shareable path. Idempotent: an already-shared tour returns its existing slug.
  2. `GET /shared/:slug` is **public** (no auth, no CSRF) and returns map geometry, the ordered cache list, totals, and score breakdown from a **snapshot stored on the tour** — never the owner id/email/display name, and never the user's other tours. The shared view never reads owner-scoped cache tables (see [ADR-0022](../adr/0022-tour-sharing-link-security.md)).
  3. The anonymous view is strictly read-only: no save, edit, re-plan, or owner-scoped cache-detail calls.
  4. `DELETE /tours/:id/share` revokes (nulls the slug); the old URL immediately 404s. Re-sharing mints a **new** slug — old links stay dead.
- **FR-P4 (authentication).**
  1. Email + password registration with **argon2id** hashing. Email is `CITEXT UNIQUE`; a duplicate returns 409.
  2. Login verifies the password and establishes a session delivered as a JWT in an httpOnly, `SameSite=Lax`, `Secure` (prod) cookie, plus a CSRF token. The session model (stateless JWT vs. Valkey-backed server sessions) is decided in [ADR-0021](../adr/0021-auth-and-session-strategy.md); the cookie + CSRF + guard surface is identical either way.
  3. **Google OAuth** (authorization-code flow) is an alternative sign-in, shipped in the first M6 release alongside password auth. It links to an existing account by **verified** email, or creates an OAuth-only user (`password_hash IS NULL`). No Google tokens are persisted (see [NFR-10](non-functional.md)).
- **FR-P5 (account creation policy).** Registration is **self-service and open** — anyone can create an account from the register page; no invite tokens. Password rules are NIST-aligned: minimum 10 characters, reject common/breached passwords, no composition rules, accept up to ≥ 128 characters.
- **FR-P6 (logout).** `POST /auth/logout` clears the auth + CSRF cookies. With Valkey-backed sessions it also deletes the session server-side (instant revocation); with stateless JWT it is a cookie-clear only unless a denylist is added. The chosen behaviour is recorded in [ADR-0021](../adr/0021-auth-and-session-strategy.md).
- **FR-P7 (session lifetime / refresh).** A short access lifetime with sliding/refresh extension; on expiry the client receives 401, attempts a silent refresh, and — failing that — redirects to login. Exact TTLs and the refresh mechanism are specified in [design/auth-and-sharing.md](../design/auth-and-sharing.md).
- **FR-P8 (CSRF protection).** Double-submit cookie: a non-httpOnly `csrf` cookie is echoed by the client in an `X-CSRF-Token` header, compared server-side. Required on all state-changing methods (POST/PATCH/DELETE). `GET /shared/:slug` and `GET /auth/me` are exempt. `SameSite=Lax` already blocks cross-site POST; the token is defense-in-depth.
- **FR-P9 (login rate limiting).** Per-IP and per-email throttling on `/auth/login` and `/auth/register` (`@nestjs/throttler`, Valkey-backed so it holds across replicas). Errors are generic — no user enumeration via message or timing.
- **FR-P10 (dev-user data ownership).** The `dev@gctp.local` bypass user remains **only** behind a gated flag (`AUTH_DEV_BYPASS`, hard-refused under `NODE_ENV=production`, mirroring today's middleware), used by local dev and Playwright e2e. There is no automatic production claim of dev-owned rows; a documented one-off operator script re-points `dev@gctp.local`-owned rows to a real account when needed.
- **FR-P11 (shared-view scope + public-endpoint inventory).** The shared view's exposed/forbidden fields are the security contract of FR-P3.2/.3. Separately, the complete set of `@Public()` (no-auth) endpoints is **normative** and enumerated below — any new public route must be added here in the same PR, so the no-auth surface cannot drift silently. An integration test asserts the live `@Public()` set matches this table.

  | Public route | Why public | Guardrails |
  | --- | --- | --- |
  | `POST /auth/register` | Can't be logged in to sign up | Rate-limited per-IP + email (FR-P9); generic errors; password rules (FR-P5) |
  | `POST /auth/login` | Establishes the session | Rate-limited; argon2 verify; generic "invalid credentials" |
  | `GET /auth/google`, `GET /auth/google/callback` | OAuth entry + provider return | `state` for CSRF; link only by verified email; no Google tokens stored |
  | `GET /shared/:slug` | Anonymous read-only shared tour (FR-P3) | Snapshot only; no owner identity / other tours; read-only; revocable |
  | `/health` | Liveness probe | No data |

  **Explicitly NOT public** (require a valid session): `GET /auth/me`, `POST /auth/logout`, and `POST`/`DELETE /tours/:id/share` — share _management_ stays owner-authenticated; only the `GET /shared/:slug` _read_ is public. Every other endpoint (`/caches`, `/gpx`, `/tours/*`, `/routing`, `/landuse*`, `/admin/*`) requires auth per FR-P12.

- **FR-P12 (auth on existing endpoints).** Once M6-α lands the global guard, all currently owner-scoped endpoints require a valid session. `/admin/*` is treated as **admin = authenticated** for now (any logged-in user); a real role is deferred, with `users.is_admin` noted as the future hook.
