## Summary

What does this PR change? Keep it to a few bullets.

## Motivation

Why now? Link the issue this closes:

Closes #

## Approach

Brief description of how. Call out anything non-obvious. If this touches an ADR-level decision, link the new or amended ADR.

## Roadmap

Which milestone (M1–M8 in [docs/requirements/roadmap.md](../docs/requirements/roadmap.md)) does this contribute to?

## Docs checklist

Docs and code change together — see [docs/sdlc/docs-policy.md](../docs/sdlc/docs-policy.md). Tick everything that applies, or pick the last option and explain.

- [ ] Updated `docs/requirements/<area>.md` for any user-visible change
- [ ] Updated `docs/design/` or `docs/architecture/` for any structural change
- [ ] Updated [docs/requirements/roadmap.md](../docs/requirements/roadmap.md) if milestone scope or status changed
- [ ] Updated [docs/PLANNER_TUNING.md](../docs/PLANNER_TUNING.md) for any new / changed `PLANNER_*` env knob
- [ ] Added or updated an ADR (`docs/adr/NNNN-...md`) if a design decision changed
- [ ] Updated [CLAUDE.md](../CLAUDE.md) if agent guidance changed
- [ ] Updated the public landing page (`apps/web/src/features/landing/LandingPage.tsx`, `/welcome`) if a shipped change alters what users can do
- [ ] PWA/caching change? Followed [ADR-0029](../docs/adr/0029-frontend-offline-resilience-caching-and-state.md): SW `navigateFallbackDenylist` covers new origin/edge paths; stable-named assets stay `no-cache`; bumped `?v=N` on manifest icon `src`s for any icon byte change
- [ ] No docs change needed (explain): <why>

## Verification

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm test:e2e` passes (when touching the API ↔ web boundary)
- [ ] `pnpm licenses:check` passes
- [ ] No Groundspeak icons added; OSM attribution preserved on any map view changed

## Notes for reviewer

Anything specific you want a second pair of eyes on, alternatives you considered, or follow-ups that intentionally stay out of scope.
