# Docs policy

Docs and code change together. A PR that ships a behaviour change without a docs change is incomplete.

## The rule

Any PR that adds or changes:

- a functional requirement,
- an external API surface (endpoints, request/response shapes, error semantics),
- an env knob or feature flag,
- a user-visible behaviour,
- a runtime dependency or framework choice,

MUST update the matching file under [requirements/](../requirements/index.md), [design/](../design/index.md), or [architecture/](../architecture/index.md) **in the same PR**.

The [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) has a docs checklist. Skipping it requires an explicit "no docs change needed" justification in the PR body. Examples of legitimate "no docs change needed":

- Pure bug fixes that restore documented behaviour (the doc was already right; code was wrong).
- Internal refactors with no externally-visible effect.
- Test-only changes.
- Comment / typo / formatting changes.

## Where things go

| You're changing | Update |
|---|---|
| A user-visible feature (FR-*) | The matching `docs/requirements/<area>.md` |
| A non-functional property (NFR-*) | [requirements/non-functional.md](../requirements/non-functional.md) |
| The roadmap (milestone status, scope) | [requirements/roadmap.md](../requirements/roadmap.md) |
| An API endpoint shape | [design/api-surface.md](../design/api-surface.md) |
| A DB schema | [design/data-model.md](../design/data-model.md) + a migration (see [migrations.md](migrations.md)) |
| An algorithm | The matching file under `docs/design/` (e.g. [tour-planning.md](../design/tour-planning.md)) |
| A new module or backend boundary | [architecture/backend.md](../architecture/backend.md) |
| A new background job or queue | [architecture/background-and-deploy.md](../architecture/background-and-deploy.md) |
| Why we picked X over Y for a non-obvious decision | A new ADR under `docs/adr/` |
| An env knob that tunes the planner | [PLANNER_TUNING.md](../PLANNER_TUNING.md) |
| Agent / Claude instructions | [CLAUDE.md](../../CLAUDE.md) |

## Requirement IDs

- Each FR/NFR has a stable ID: `FR-<area-letter><number>` (e.g. `FR-I8`, `FR-T7`) or `NFR-<number>`.
- IDs are append-only — never re-number. If a requirement is removed, leave a one-line tombstone: `~~FR-X3.~~ Removed in M6; see ADR-0009.`
- New IDs claim the next free number in their section. Check the relevant `docs/requirements/<area>.md` for the current max.

## ADRs

Lightweight Nygard format. Write one when a future contributor would reasonably ask "why was X chosen?" — framework, license, algorithm class, replacing a popular tool with a less popular one. Don't write one for naming, formatting, or routine refactors. See [docs/adr/README.md](../adr/README.md) for naming + state conventions.

## Why this matters

The previous incarnation of this project drifted: code changed, docs didn't, and within a year nobody could tell which doc was authoritative. The cost of a one-paragraph docs update during a PR is tiny; the cost of trusting stale docs six months later is enormous. This policy keeps docs at the same freshness as the code that imports them.
