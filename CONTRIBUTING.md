# Contributing to gc-tour-planner

Thanks for your interest. This is a personal-but-open project — contributions are welcome, with a few ground rules.

## Code of conduct

By participating you agree to abide by the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Licensing

This project is **GPL-3.0-or-later**. By submitting a PR you agree your contribution is licensed under the same terms. We do **not** require a CLA — your `git commit --author` is your sign-off.

Every new TS / JS / SQL source file in `apps/` and `packages/` must start with:

```
// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
```

See [docs/LICENSING.md](docs/LICENSING.md) for full third-party license rules — notably:

- **Use Valkey, not Redis.** Redis 7.4+ is SSPL/RSAL (see [ADR-0004](docs/adr/0004-valkey-over-redis.md)).
- **Never bundle Groundspeak attribute icons** — use Material Symbols or text chips.

## Before you start a non-trivial change

1. Read [docs/requirements/](docs/requirements/index.md), [docs/architecture/](docs/architecture/index.md), and [docs/design/](docs/design/index.md).
2. Read [docs/sdlc/](docs/sdlc/index.md) for branching, testing, migrations, and the docs-sync policy.
3. Skim [docs/adr/](docs/adr/) for the _why_ behind non-obvious choices.
4. **Open an issue first** if your change spans multiple modules, alters a documented decision, or adds a new dependency. We can save you a rewrite.
5. If you're changing a documented architectural decision, **write a new ADR** in the same PR.

## Development setup

```bash
# from repo root
pnpm install
cd infra
cp .env.example .env
docker compose up --build              # first boot preprocesses OSRM, ~10 min
```

Per-package dev:

```bash
pnpm --filter @gctp/api dev
pnpm --filter @gctp/web dev
```

Quality gates (all must pass):

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm licenses:check
```

## Coding conventions

- Filenames: `kebab-case.ts`. React components `PascalCase`. Nest classes `PascalCase`.
- **Layering:** `controller → service → repository → Kysely`. Controllers never touch SQL.
- **Zod schemas** in `packages/shared` — single source of truth for wire DTOs.
- **Migrations** in `packages/db/migrations/` as plain SQL via `node-pg-migrate`. One change per file. Never edit a merged migration.
- **Tests** co-located as `*.spec.ts`. Integration tests use Testcontainers PostGIS — **do not mock the DB**.
- **Comments**: only when the _why_ is non-obvious. Don't restate code in prose.

## Adding a dependency

1. Check the license against [LICENSING.md §2](docs/LICENSING.md#2-hard-compatibility-rules). SSPL / RSAL / BUSL / Commons Clause / CC-BY-NC are hard rejects.
2. Prefer dependencies with active maintenance and TypeScript types.
3. If you're adding something that displaces an existing dependency (or that the README says we _don't_ use), write an ADR.

## Commit + PR style

- Conventional Commits encouraged but not required: `feat(api): ...`, `fix(web): ...`, `docs: ...`, `chore: ...`.
- One logical change per PR. Small PRs land faster.
- PR description must include: what changed, why, and how it was tested. Use the PR template.
- Link the issue you're closing.

## Reporting bugs

Open a GitHub issue using the **Bug report** template. Include reproducible steps, expected vs actual behavior, environment, and (if relevant) a minimal GPX or query that triggers the bug.

## Feature requests

Use the **Feature request** template. Tie it to the roadmap milestone it belongs to ([docs/requirements/roadmap.md](docs/requirements/roadmap.md)).

## Security

Do **not** open public issues for security problems. Email the project owner directly — see the GitHub profile.

## Questions

GitHub Discussions (once enabled) is the right place for design questions and "how do I…". Until then, open an issue tagged `question`.
