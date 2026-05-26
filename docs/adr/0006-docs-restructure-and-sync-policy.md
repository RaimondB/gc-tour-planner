# ADR-0006 — Docs restructure into per-area subdirectories + sync policy

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Raimond Brookman (owner)

## Context

`docs/REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, and `docs/DESIGN.md` had each grown past 13 KB / 200 lines. Adding a new requirement, a new module, or a new algorithm meant editing a large monolith — which made PRs noisier, encouraged "I'll update the docs later" deferrals, and made it harder for new contributors (human or agent) to find the right section quickly.

Two related problems surfaced in the same conversation:

1. The docs are getting long enough that splitting helps navigation.
2. Behaviour-changing PRs sometimes ship without docs updates, and the drift accumulates.

A future "rewrite the docs from scratch" project is far more expensive than continuously keeping them current — but only if the friction of "add one line in the right file" is low.

## Decision

**Split each monolith into a per-area subdirectory with an `index.md`.** Each top-level section of the original file becomes one file in the new directory; closely-related short sections may merge if a file would otherwise be < ~30 lines (e.g. ARCHITECTURE.md's "Background work" + "Deployment topology" merged into `background-and-deploy.md`). Cross-links use the existing relative-markdown style.

Layout:

```
docs/
  requirements/
    index.md            # links + §1 Problem statement + §2 Personas
    ingest.md           # FR-I*
    filtering.md        # FR-F*
    tour-planning.md    # FR-T*
    persistence-sharing.md  # FR-P*, M6
    map-ui.md           # FR-M*
    non-functional.md   # NFR-*
    out-of-scope.md
    roadmap.md          # M1–M8 table
    acceptance.md       # E2E smoke
  architecture/
    index.md
    system-context.md
    repo-layout.md
    backend.md
    frontend.md
    data-flow.md
    background-and-deploy.md
    non-goals.md
  design/
    index.md
    data-model.md
    api-surface.md
    tour-planning.md
    gpx-parsing.md
    osm-overpass.md
    routing-osrm.md
    frontend.md
    conventions.md
    open-questions.md
  sdlc/                 # NEW
    index.md
    branching-and-prs.md
    testing.md
    migrations.md
    release-and-deploy.md
    docs-policy.md
  adr/                  # unchanged
  PLANNER_TUNING.md     # unchanged (already focused)
  LICENSING.md          # unchanged (already focused)
```

The old monoliths become one-line redirect stubs (`Moved to [requirements/](requirements/index.md).`) for one milestone, then get deleted.

**Adopt a docs-sync policy** captured in [`docs/sdlc/docs-policy.md`](../sdlc/docs-policy.md):

- Any PR that changes a functional requirement, an external API surface, an env knob, or a user-visible behaviour MUST update the matching file under `docs/requirements/`, `docs/design/`, or `docs/architecture/` in the same PR.
- The [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) has a docs checklist; "no docs change needed" requires explicit justification.
- The same rule is duplicated in [CLAUDE.md](../../CLAUDE.md) so every agent session loads it.

## Why per-area subdirectories over flat top-level files

Considered: `docs/requirements-ingest.md`, `docs/requirements-filtering.md`, etc. Rejected — it makes `docs/` itself crowded (~25 files), and people land in `docs/` before they land in any particular file. A subdirectory + index gives newcomers one obvious entry point per topic.

## Why PR template + CLAUDE.md instead of a CI scripted check

Considered: a CI script that fails any PR which touches `apps/api/src/**/controller.ts` or `packages/db/migrations/` without touching `docs/`. Rejected:

- Too easy to game (add a whitespace-only line to a docs file).
- False positives are inevitable (a controller-internal refactor genuinely needs no docs change) and tuning the path matchers per area would be a maintenance burden.
- Two human-readable checkpoints (PR template + CLAUDE.md rule) are sufficient and degrade gracefully — a reviewer sees the unticked checklist immediately.

We can revisit and add a CI check later if review fatigue sets in; ADR-supersession is the path for that.

## Consequences

**Good**

- Smaller, more focused files; easier diffs in PRs.
- Sub-pages have stable URLs / paths — easier to link from CLAUDE.md, ADRs, and code comments.
- Adds an explicit `sdlc/` doc tier that didn't exist before.
- Makes "where do I document this?" a one-question lookup (the table in [docs-policy.md](../sdlc/docs-policy.md)).

**Trade-offs**

- More files in `docs/`. Browsing requires the index.md indirection.
- The split is one-time disruptive: every existing link in the repo (CLAUDE.md, README, CONTRIBUTING, code comments) needs updating in the same PR.
- The next ADR for the precompute work becomes ADR-0007 instead of ADR-0006.

## How to apply

For everyone (humans and agents):

- Read the [SDLC docs](../sdlc/index.md) before opening a PR that changes behaviour.
- When adding a feature, find its matching `docs/requirements/<area>.md` and append a new FR with the next free ID.
- When changing an algorithm or schema, update the matching `docs/design/` file in the same PR.
- When the change is non-obvious enough that a future reader would ask "why?", write an ADR.
