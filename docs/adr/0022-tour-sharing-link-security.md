# ADR-0022 — Read-only tour sharing & link security

- **Status:** Proposed
- **Date:** 2026-06-06
- **Deciders:** Raimond Brookman (owner)

## Context

[FR-P3](../requirements/persistence-sharing.md) lets a user share a saved tour as a read-only link an anonymous recipient can open — map plus cache list, no login. The `tours` table already designs a nullable `share_slug TEXT UNIQUE`. Two things need deciding: how the slug is generated (so links aren't guessable or enumerable), and how the public endpoint serves tour data **without** leaking the owner's identity or their owner-scoped caches table.

## Decision

1. **Opaque slug.** 16-char base32 from `crypto.randomBytes(10)` (~80 bits), non-sequential, carrying no owner or tour-id information. Retry on the rare unique-constraint collision. Minted by `POST /tours/:id/share` (idempotent — returns the existing slug if already shared).
2. **Public read via snapshot.** `GET /shared/:slug` is unauthenticated (in the `@Public()` inventory) and returns a `SharedTour` DTO assembled from data **snapshotted onto the tour at save time** — name, totals, score breakdown, routed polyline, parking point, and a denormalised cache list (id/code/type/name/location). It performs **no** owner-scoped cache reads.
3. **No owner identity.** The payload never includes owner id, email, or display name, and never the user's other tours.
4. **Revocation.** `DELETE /tours/:id/share` nulls the slug; the old URL immediately 404s. Re-sharing mints a **new** slug, so previously distributed links stay dead. Deleting the tour also revokes the share.

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

- Each shared tour carries a denormalised cache snapshot — small extra storage in the `plan`/snapshot JSON.
- The snapshot can drift from the live caches over time (e.g. a cache later disabled). Acceptable: a shared tour is a point-in-time artifact, documented as such.

**Not in scope here**

- Editable or collaborative shares, share expiry/TTL, and per-link access counts — none are required by M6.
