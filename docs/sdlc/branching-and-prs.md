# Branching + PRs

## Branches

- `main` — always deployable and **branch-protected**: changes land only via a pull request with green CI; no direct pushes or force-pushes. **UAT tracks `main`** (see Development workflow).
- Feature branches: `<area>/<short-slug>`, e.g. `planner/marginal-trim`, `infra/deploy-uat`.
- No long-lived release branches — UAT is cut from `main`.

## Development workflow (dev → PR → main → UAT)

The path for any change, from idea to running in UAT:

1. **Branch** off `main` (`<area>/<slug>`). `main` is protected — you can't push to it directly.
2. **Build and test on the dev environment.** Iterate with `pnpm dev` — the isolated `gctp-dev` compose project on shifted ports (see [release-and-deploy.md](release-and-deploy.md)). **Dev is the only place a feature branch is exercised**; never deploy an in-flight branch to UAT.
3. **Open a PR** into `main`. CI runs automatically.
4. **Merge** once CI is green (branch protection enforces a PR + passing checks — see Merge policy).
5. **Promote to UAT.** After the merge, bring UAT up to the new `main` (pull + redeploy — see [release-and-deploy.md](release-and-deploy.md)).

The split is the point: **feature branches live on dev, `main` lives on UAT.** Only merged-to-`main` code ever runs in UAT — the two environments never blur.

## Commit messages

Conventional Commits, scoped to the area touched:

- `feat(planner): loop-aware Pass 2 legs + numbered tour UI`
- `fix(web): MapLibre style fallback + container resize observer`
- `feat(infra): UAT deployment via reverse proxy + planner env knobs`
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

`main` is **branch-protected** (configured on GitHub):

- A pull request is required — direct pushes to `main` are blocked.
- The **`build`** and **`licenses`** CI checks must pass, and the branch must be up to date with `main`, before merge. (`docs-links` also runs, but is **advisory** — see CI gate.)
- No force-pushes or deletions of `main`.
- **0 required approvals** while this is a solo project (you can't approve your own PR; raise this once there are collaborators). **Admins may bypass** for an emergency hotfix — everything else goes through a PR.
- Conversation resolution is required before merge.

Then:

- **Squash merge** is the default. Keeps `main` linear and one-commit-per-PR.
- Force-pushes to a feature branch are fine while a PR is open. Force-pushes to `main` are not.
- Never skip pre-commit hooks or sign-off (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks. If a hook fails, fix the cause, don't bypass.

## CI gate

Two checks **gate** every PR (both required by branch protection):

- **`build`** — `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`. Note: `format:check` does **not** cover Markdown — that's hand-authored prose; see `docs-links` for the check that does apply to it.
- **`licenses`** — `pnpm licenses:check` (every runtime dep must be GPLv3-compatible).

One check is **advisory** (runs on every PR, but deliberately **not** in branch protection's required list, so it never blocks a merge):

- **`docs-links`** — lychee, run **offline**: flags relative links and in-page `#anchor`s between Markdown files that don't resolve to a real path/heading. It goes red on a broken link as a visible signal, but a stale doc link shouldn't block shipping code — fix it in-PR or in follow-up. External URLs are intentionally **not** checked (non-deterministic). This is the integrity check for our heavily cross-linked docs/ADRs now that Prettier no longer touches Markdown.

`pnpm test:e2e` (Playwright) is run when touching the API ↔ web boundary. Red CI on a **required** check blocks merge; a red `docs-links` does not.

> To promote `docs-links` from advisory to blocking later, add it to branch protection's required-status-checks list (a GitHub repo setting).
