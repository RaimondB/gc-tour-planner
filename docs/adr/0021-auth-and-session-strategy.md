# ADR-0021 — Authentication & session strategy

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Raimond Brookman (owner)

## Context

M6 turns gc-tour-planner from a single-stub-user app into a real multi-user one. Today every request is attributed to a `dev@gctp.local` user by `DevUserMiddleware` (`apps/api/src/auth/dev-user.middleware.ts`), which throws under `NODE_ENV=production`. The `users` table already exists (`password_hash` nullable, unused), and per-user isolation is already enforced in every repository via `owner_id`. What's missing is the layer that authenticates a real user and populates the request user.

The requirement ([FR-P4](../requirements/persistence-sharing.md)) calls for email+password **and** Google OAuth, with the session in an httpOnly `SameSite=Lax` cookie plus CSRF. The open question is the **session model**, because Valkey is already a load-bearing dependency ([ADR-0004](0004-valkey-over-redis.md)) and that changes the trade-off the original wording assumed.

## Decision

1. **Passwords:** argon2id via the `argon2` package (MIT), tuned to ~50–100 ms on target hardware. Chosen over bcrypt for memory-hardness.
2. **Session model:** server-side sessions stored in **Valkey**, keyed by an opaque id carried in an httpOnly, `SameSite=Lax`, `Secure` (prod) cookie. Rationale: instant logout/revocation (FR-P6) and "log out everywhere" come for free; the per-request cost is one Valkey read, and Valkey is already in the hot path for login throttling. This supersedes FR-P4's original "JWT in httpOnly cookie" wording — there is **no** sessions table in Postgres. The stateless-JWT-in-cookie alternative is recorded below; the cookie + CSRF + guard surface would be identical, only the guard's verify step differs.
3. **CSRF:** double-submit cookie. A non-httpOnly `csrf` cookie is echoed in an `X-CSRF-Token` header on all state-changing methods; `SameSite=Lax` is the primary defense, the token is defense-in-depth.
4. **Guard:** a global `JwtAuthGuard` replaces `DevUserMiddleware`. Everything is authenticated by default; a `@Public()` decorator exempts the small, enumerated set in [the public-endpoint inventory](../design/auth-and-sharing.md). A dev/e2e bypass stays behind `AUTH_DEV_BYPASS=1`, hard-refused under `NODE_ENV=production`.
5. **Google OAuth:** authorization-code flow, shipped in M6-α. Links to an existing account by **verified** email, else creates an OAuth-only user (`password_hash IS NULL`). A signed `state` parameter protects the round-trip. **No Google access/refresh tokens are persisted** — we keep project identity only, reinforcing the "no third-party creds in DB" hard rule. Library preference: lightweight `openid-client` + `jose`; `passport-google-oauth20` (MIT) as fallback.
6. **Rate limiting:** `@nestjs/throttler` with a Valkey store, per-IP and per-email on `/auth/login` and `/auth/register`, generic errors (no user enumeration).

## Alternatives considered

- **Stateless JWT in cookie (the original FR-P4 wording).** No per-request store hit and trivial replica scaling, but logout/revocation needs a short TTL plus a denylist, and rotating the signing secret invalidates every session. Rejected as the default in favour of Valkey sessions; retained as the documented fallback because the surrounding surface is identical.
- **bcrypt** instead of argon2id — rejected (not memory-hard).
- **Synchronizer-token CSRF** (server-stored per-session token) — rejected; double-submit is stateless and sufficient alongside `SameSite=Lax`.
- **A long-lived dev bypass in production** — rejected; the bypass is gated and refused in prod.

## Consequences

**Good**

- Real multi-user auth with instant logout/revocation and a clean "log out everywhere".
- The `@CurrentUser()`/`AuthUser` contract and every owner-scoped repository are unchanged — M6 swaps only the request-user source.
- OAuth and password users coexist in one `users` table (nullable `password_hash`).

**Trade-offs**

- One Valkey read per authenticated request (cheap; Valkey already required).
- New runtime deps to license-vet and record in [../LICENSING.md](../LICENSING.md): `argon2`, `jose`, `@nestjs/throttler`, `cookie-parser`, `helmet`, and the OAuth library.
- Session secret + OAuth client secret become required env knobs (env-only, never tracked) — see [NFR-10](../requirements/non-functional.md).

**Not in scope here**

- Forgot-password / email verification (need email infra) — deferred past M6.
- A real admin role — `/admin/*` is "admin = authenticated" for now, with `users.is_admin` noted as the future hook (FR-P12). _(Since implemented: the `users.is_admin` column + an `AdminGuard` now gate `/admin/*` and the destructive purge route — see [FR-P12](../requirements/persistence-sharing.md).)_
