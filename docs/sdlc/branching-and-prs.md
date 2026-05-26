# Branching + PRs

## Branches

- `main` — always deployable. CI gates merges.
- Feature branches: `<area>/<short-slug>`, e.g. `planner/marginal-trim`, `infra/traefik-uat`.
- No long-lived release branches — UAT is cut from `main`.

## Commit messages

Conventional Commits, scoped to the area touched:

- `feat(planner): loop-aware Pass 2 legs + numbered tour UI`
- `fix(web): MapLibre style fallback + container resize observer`
- `feat(infra): UAT deployment via Traefik + planner env knobs`
- `docs(planner): add PLANNER_TUNING.md`
- `chore(deps): bump kysely to 0.27.x`

Tense: imperative (`add`, `fix`, `update`) — not past tense.

Body: focus on the **why**, not the what. The diff already shows what. Keep to one paragraph; use bullets sparingly.

Trailer: when a Claude-assisted commit goes in, include the `Co-Authored-By` line that Claude Code emits.

## PRs

Use the [PR template](../../.github/PULL_REQUEST_TEMPLATE.md). One logical change per PR. A PR that does three unrelated things should be three PRs.

Title: same Conventional Commit format as the squash commit will use.

Keep PRs small enough to review in one sitting (~400 lines diff is a rough north star). Long-running multi-PR work (e.g. a milestone) gets a tracking issue.

## Merge policy

- **Squash merge** is the default. Keeps `main` linear and one-commit-per-PR.
- Force-pushes to a feature branch are fine while a PR is open. Force-pushes to `main` are not.
- Never skip pre-commit hooks or sign-off (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks. If a hook fails, fix the cause, don't bypass.

## CI gate

Every PR must pass: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` (when touching the API ↔ web boundary), `pnpm licenses:check`. Red CI blocks merge.
