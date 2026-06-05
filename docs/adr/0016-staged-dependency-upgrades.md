# ADR-0016 — Staged dependency upgrades (clusters, not big-bang)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0003](0003-license-gplv3.md), [ADR-0004](0004-valkey-over-redis.md); operational doc: [docs/sdlc/dependency-upgrades.md](../sdlc/dependency-upgrades.md)

## Context

The repo had drifted behind on dependencies — Dependabot reported critical/high
runtime advisories, and large parts of the stack (NestJS 10, Express 4, zod 3,
React 18, Vite 5, Vitest 2) are a major version or more behind latest. We want to
stay current for both security and maintenance, but "current" here means **six
distinct breaking-major migrations**, not a single bump.

The tempting move — `pnpm update --latest` across the whole monorepo in one
branch — is the wrong one here:

1. **Un-bisectable.** Six simultaneous breaking majors means a red CI run gives no
   signal about which major broke it.
2. **Unverifiable in one pass.** The risky majors sit on the HTTP/DB layer (Nest +
   Express) and in the browser app (React + MapLibre + Vite). Their real safety
   nets are the Testcontainers integration tests (need Docker) and Playwright e2e
   (need the full compose stack) — both are per-area, not run on a generic bump.
3. **License exposure.** Every re-resolved tree must stay GPLv3-compatible
   ([ADR-0003](0003-license-gplv3.md)); a careless major can pull an SSPL/BUSL
   transitive (cf. the Valkey-not-Redis constraint, [ADR-0004](0004-valkey-over-redis.md)).
   A big-bang diff makes that gate hard to reason about.

## Decision

**Upgrade in staged clusters, each its own branch/PR, green before the next.**

- A **cluster** groups packages that must move together (peer-coupled) and excludes
  anything that would drag in an unrelated breaking major. A package's cluster is
  decided by its coupling, not its name.
- Clusters land roughly lowest-risk → highest-blast-radius. The running order and
  status live in the operational doc, not here (this ADR records the _why_; the doc
  records the _what's-next_).
- Each open advisory is triaged for **reachability** first: reachable → fix
  (override or move the owning cluster); not reachable → document and leave, rather
  than forcing a risky cross-major override against an exact pin.
- **`pnpm licenses:check` is a mandatory gate on every cluster**, not just feature
  PRs — majors are exactly when bad-licensed transitives sneak in.
- A breaking-major cluster gets its own ADR (status `Proposed`) before its code PR.

This strategy is already in use: clusters 1 (runtime security pass, #11/#12) and 2
(leaf bumps, #13) merged under it.

## Consequences

- **More PRs, more CI round-trips** than a single bump — accepted in exchange for
  reviewable, bisectable, individually-revertable changes.
- **Some advisories stay open between clusters** (e.g. the `multer` HIGH alerts wait
  for the Nest 11 / Express 5 cluster). We accept a documented, time-boxed window
  rather than a rushed risky bump. Triaged-not-reachable advisories may stay open
  indefinitely with a written rationale.
- **The cluster map is living state.** It lives in
  [docs/sdlc/dependency-upgrades.md](../sdlc/dependency-upgrades.md) and is updated as
  clusters land; this ADR does not need amending when the map changes.
- **Reversible:** nothing here constrains the code — it's a process choice. If the
  project gains contributors and CI capacity, clusters can be parallelised or
  Dependabot auto-merge enabled for the leaf tier without superseding this ADR.
