# ADR-0033 — Machine ingestion API for programmatic GPX upload

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Raimond Brookman (owner)

## Context

Cache data enters the system today only through the browser GPX upload (`POST /gpx/upload`, [FR-I1]), which is authenticated by the httpOnly session cookie + double-submit CSRF token ([ADR-0021](0021-auth-and-session-strategy.md)) and attributes caches to `req.user.id`. That is exactly right for a human in a browser, but it makes it impossible for a **trusted non-browser client** — a script, a scheduled job, a CI step, or a future external *source adapter* — to upload GPX cache files on a user's behalf: such a client has no session cookie and cannot satisfy CSRF.

We want a way for trusted automated clients to push GPX into the existing ingest pipeline **without weakening the browser auth model** and without inventing per-call "act as user X" parameters.

## Decision

1. **A new dedicated route, `POST /ingest/gpx`.** Same multipart `file` contract and 64 MB cap as `POST /gpx/upload`, reusing `GpxService.ingest()` **unchanged** — so FR-I3 upsert, FR-I10 staleness guard, FR-I12 byte-dedup, and FR-I8 precompute all apply identically. The browser upload route is untouched; the two auth surfaces never mix.

2. **Bearer-token auth, CSRF-exempt.** The client presents `Authorization: Bearer <token>`. A bearer in a header is **not** an ambient credential (a browser never attaches it cross-site), so CSRF does not apply and no cookie is read. Owner is the **token's** actor, never a request-supplied id — there is no on-behalf-of escape.

3. **Single env key now, PAT-shaped seam.** The shipped credential is one shared `INGEST_API_KEY` mapping to one `INGEST_OWNER_ID`, **env-only, never in the DB** — the same "no third-party creds in DB" pattern as the M8 partner key ([FR-I6]). The guard resolves token → owner through an injectable `IngestTokenResolver` interface, so a future DB-backed **per-user personal-access-token (PAT)** store drops in as a new provider with **zero** change to the guard, the controller, or the client contract. Disabled by default (`INGEST_API_ENABLED`); when enabled, both env vars are required at boot, and a `INGEST_OWNER_ID` with no matching user logs a soft startup warning.

4. **`@MachineAuth()`, not `@Public()`.** The global `JwtAuthGuard` gets an early step-aside branch when a route is marked `@MachineAuth()` (mirroring its `@Public()` branch); a route-level `IngestAuthGuard` then does the real bearer check. The route is deliberately **not** added to the `@Public()` set — `@Public()` is the *no-auth* inventory and must stay truly no-auth. Machine routes are authenticated, just by a different credential, so they get their **own** normative inventory test (`machine-auth-inventory.spec.ts`), the sibling of the FR-P11 public-route inventory, so the no-session surface cannot drift silently.

5. **Clarification of "no auth tokens in the DB."** The auth contract ([ADR-0021], CLAUDE.md) forbids persisting **session tokens** and **Google OAuth access/refresh tokens** in the DB. A future ingestion PAT store does not breach it: it stores a **hash** of the token (never the token itself), exactly as passwords are stored — it is a verifier, not a recoverable credential. The shipped env-key approach stores nothing in the DB at all.

## Alternatives considered

- **Reuse `/gpx/upload` with dual auth (cookie OR bearer).** Rejected: mixes two auth modes and CSRF logic on one route and muddies the security inventory. A dedicated route is clearer to document and to pin.
- **Per-user PATs in the DB now.** Deferred, not rejected: heavier (migration + token-management UI) than current needs. The resolver seam makes it a purely additive follow-up.
- **Make the route `@Public()`.** Rejected: it *is* authenticated (by a bearer), so putting it in the no-auth inventory would be misleading and erode that contract.
- **A request-supplied `ownerId` parameter on the existing endpoint.** Rejected: an on-behalf-of escape hatch. Binding owner to the token is safer and simpler.

## Consequences

**Good**

- Trusted scripts / scheduled jobs / future source adapters can upload GPX without a browser session.
- The same seam serves any future sanctioned source (e.g. OKAPI [M7], a GC.com API adapter [M8]) — they would authenticate to `/ingest/gpx` (or call `GpxService` directly) rather than each reinventing ingest.
- `GpxService` and every owner-scoped repository are unchanged; the new route is a thin auth wrapper.
- The no-session surface is a one-line, test-pinned inventory.

**Trade-offs**

- The `@MachineAuth()` early-return touches the security-critical global guard — mitigated by the dedicated inventory test.
- Single shared key = single owner until the DB-backed PAT store lands; a leaked key ingests to that one owner (rotate via env).
- A wrong `INGEST_OWNER_ID` would silently ingest to a non-existent owner — mitigated by the boot refusal on blank values and the soft owner-existence warning.
