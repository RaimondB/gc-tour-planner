# ADR-0022 — Read-only tour sharing & link security

- **Status:** Proposed
- **Date:** 2026-06-06
- **Deciders:** Raimond Brookman (owner)

## Context

[FR-P3](../requirements/persistence-sharing.md) lets a user share a saved tour as a read-only link an anonymous recipient can open — map plus cache list, no login. The `tours` table already designs a nullable `share_slug TEXT UNIQUE`. Two things need deciding: how the slug is generated (so links aren't guessable or enumerable), and how the public endpoint serves tour data **without** leaking the owner's identity or their owner-scoped caches table.

## Decision

1. **Opaque slug.** 16-char base32 from `crypto.randomBytes(10)` (~80 bits), non-sequential, carrying no owner or tour-id information. Retry on the rare unique-constraint collision. Minted by `POST /tours/:id/share` (idempotent — returns the existing slug if already shared).
2. **Snapshot captured at save.** When the user saves the tour (`POST /tours`), the cache list is **denormalised into the tour's `plan` JSONB column at that moment** — id/code/type/name/location per cache. This is the same single `plan` column that holds the `PlanResult` (FR-P1); there is no separate snapshot column and no re-snapshot at share time. The snapshot is therefore a point-in-time image as of **save**.
3. **Public read via snapshot.** `GET /shared/:slug` is unauthenticated (in the `@Public()` inventory) and returns a `SharedTour` DTO assembled **only** from the stored snapshot — name, **totals (distance + time) only**, routed polyline, parking point, and the denormalised cache list. It performs **no** owner-scoped cache reads.
4. **Stripped to totals — no score breakdown.** The shared payload **omits the score breakdown** and every other soft-preference internal (landuse profile, constraint weights). A shared tour is "here is a walk," not "here is how I tuned my preferences"; the score breakdown is stored on the tour (for the owner's own view) but never served on `/shared/:slug`.
5. **No owner identity.** The payload never includes owner id, email, or display name, and never the user's other tours.
6. **Not rate-limited.** `GET /shared/:slug` is intentionally not throttled — an ~80-bit opaque slug is not brute-forceable, so there is nothing to enumerate.
7. **Revocation.** `DELETE /tours/:id/share` nulls the slug; the old URL immediately 404s. Re-sharing mints a **new** slug, so previously distributed links stay dead. Deleting the tour also revokes the share.

## Alternatives considered

- **Signed-JWT share links** (all tour data encoded in a signed token, no DB lookup) — rejected: cannot be revoked once distributed, and bloats the URL.
- **Sequential / tour-id-derived slugs** — rejected: enumerable, leak how many tours exist.
- **Serving the shared view from the live owner-scoped caches** (`GET /caches`-style read under the slug) — rejected: risks leaking the owner's caches table and breaks when a referenced cache is later deleted or re-uploaded. The snapshot avoids both.

## Consequences

**Good**

- An anonymous link reveals exactly one tour's geometry and caches and nothing about the owner or their other data.
- The shared view survives deletion/re-upload of the underlying caches (it renders the stored snapshot).
- Revocation is immediate and irreversible for old links.

**Trade-offs**

- Each shared tour carries a denormalised cache snapshot — small extra storage inside the `plan` JSONB column.
- The snapshot can drift from the live caches over time (e.g. a cache later disabled). Acceptable: a shared tour is a point-in-time artifact as of save, documented as such.

**Not in scope here**

- Editable or collaborative shares, share expiry/TTL, and per-link access counts — none are required by M6.
