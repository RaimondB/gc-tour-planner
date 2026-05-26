# SDLC

How we develop, test, ship, and document changes in gc-tour-planner. Read these alongside the [requirements](../requirements/index.md), [architecture](../architecture/index.md), and [design](../design/index.md) docs.

## Parts

- [Branching + PRs](branching-and-prs.md) — branch naming, PR title style, merge policy
- [Testing](testing.md) — unit / Testcontainers integration / Playwright E2E layers, where new tests go
- [Migrations](migrations.md) — node-pg-migrate, one change per file, Kysely regen
- [Release + deploy](release-and-deploy.md) — current UAT topology, prod expectations
- [Docs policy](docs-policy.md) — the sync rule, requirement-ID allocation, ADR placement

## Where to start

- New to the repo? Read [../../CONTRIBUTING.md](../../CONTRIBUTING.md) first, then this index.
- About to open a PR? Skim [docs-policy.md](docs-policy.md) and [branching-and-prs.md](branching-and-prs.md).
- About to add a feature flag, env var, or breaking change? [docs-policy.md](docs-policy.md) is mandatory.
