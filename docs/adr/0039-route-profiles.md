# ADR-0039 — Route profiles (saved, server-side planning presets)

- **Status:** Proposed
- **Date:** 2026-11-16
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0002](0002-planner-strategy-interface.md) (no strategy-specific knobs in `PlanInput`), [ADR-0029](0029-frontend-offline-resilience-caching-and-state.md); [FR-T19](../requirements/tour-planning.md). Prepares FR-T18 (ad-hoc walk, ADR-0040).

## Context

Planning settings live only in the browser's `localStorage`
(`gctp:plan-settings`, `gctp:search`): about 25 knobs spread across the search
filters, the cluster sidebar and the tour settings. They don't follow the user to
another device, and there is no way to keep several named setups ("quick
traditionals after work", "long forest walk", "Adventure Lab day") and switch
between them.

The upcoming ad-hoc walk (FR-T18) makes this a hard requirement: in the field
the user must not configure anything except choosing a profile and a deadline.
The owner chose **one profile concept shared by the classic cluster planner and
the ad-hoc walk**.

The only profile-like storage today is `landuse_profiles` (system rows with
`owner_id IS NULL` + per-user rows), which is read-only over the API.

## Decision

1. **Table `route_profiles`** — `id uuid`, `owner_id uuid NULL` (NULL = system
   preset, read-only), `name`, `description`, `settings jsonb`, `created_at`,
   `updated_at`. Owner-scoped in the repository exactly like
   `landuse_profiles`: a user sees system rows + their own, and can only write
   their own. Names are unique per owner (case-insensitive).
2. **`settings` is a versioned zod schema in `packages/shared`**
   (`RouteProfileSettings`, `version: 1`) — the single source of truth for the
   wire and the stored JSON. Every field has a default, so a stored profile
   missing newer fields parses into a complete object (additive evolution); a
   breaking change bumps `version` with a migrating preprocess in the parser.
   The DB stores the JSON verbatim; the API re-validates on every write.
3. **A profile holds every planner setting** except the search centre ("where
   am I") and the map-display toggles (landuse overlay, saved-tour footprints).
   The owner chose full parity: whatever the planner can set, a profile can
   hold, and vice versa.

   | Group | Fields | Used by the cluster planner as | Ad-hoc walk |
   | --- | --- | --- | --- |
   | `search` | `radiusM` | search radius | — |
   | `filters` | `types[]`, `multiSubtype`, `excludeFound`, `includeDisabled`, `hideToolCaches`, `solvedMysteriesOnly`, `contexts[]`, `difficulty`/`terrain` range (**new filter**), `excludeSavedTourCaches` | search + discovery filters | candidate pool |
   | `adventures` | `include`, `keepTogether`, `interleave` | AL in clustering; solver atomicity / interleave | same |
   | `objective` | `landuseProfileId` + `landuseWeight`, `centerProximityWeight` | cluster ranking terms | scenic prize |
   | | `varietyWeight`, `preferredTypes[]` + `preferredWeight` | **new** cluster ranking terms `variety`, `preferredTypes` | per-cache prize |
   | `time` | `visitMinutes`, `visitMinutesByType` (**new**), `alStageVisitMinutes`, `toolBonusMinutes`, `walkingKmh` | visit-time totals + time model | dwell + pace |
   | `budget` | `distanceBudgetMeters` | distance budget | — |
   | | `durationMinutes` (nullable), `bufferMinutes` | **time budget** = duration − buffer, enforced on both planner paths | prefilled duration + safety margin |
   | `parking` | `startPreference`, `osmAccess`, `osmFee` | start preference + OSM parking filters | — |
   | `advanced` | `minClusterSize`, `maxLinkMeters`, `clusteringStrategy`, `topNClusters`, `fringeTrimMeters` | discovery + loop tuning | — |

   Parity means the settings that started as walk-only now **work in the cluster
   planner too**:
   - **Ranking terms.** `variety` = the mean normalised Shannon entropy of the
     cluster's cache types and difficulty bands × `varietyWeight` (defaults to 0,
     so existing rankings don't change); `preferredTypes` = the share of caches
     of a preferred type × `preferredTypeWeight`.
   - **Visit time.** One shared `visitMinutesFor(cache, model)` (per-type
     override, AL stage minutes, tool bonus) feeds both planners' totals, the
     greedy time trim and the solver (per-cache `visitSeconds`).
   - **Time budget.** With a duration set, `PlanLoopInput.timeBudgetMinutes` =
     duration − buffer. Travel time is routed metres at the user's walking speed
     (`PlanLoopInput.walkingKmh`), the same model the web uses to display
     walking time; the greedy budget-aware trim now cuts to it, and the solver
     gets pace-derived seconds plus each stop's own visit time.

4. **One mapping, one form.** `applyRouteProfile` / `profileFromPlanner` map
   one-to-one between a profile and the planner's `SearchParams` +
   `PlanSettings`. The planner's step panels and the Account-page editor render
   the **same settings sections** (`features/settings/SettingsSections.tsx`)
   over that profile-shaped value, so they can't drift apart. New request
   fields are generic planner inputs, not strategy knobs (ADR-0002 holds):
   `hardFilters.difficulty/terrain`, `softPreferences.varietyWeight /
   preferredTypes / preferredTypeWeight`, `PlanLoopInput.visitMinutesByType /
   walkingKmh` (`timeBudgetMinutes` already existed). The selected
   profile id is remembered on-device (`gctp:route-profile-id`); editing a setting
   afterwards marks the selection "modified" — it never silently writes back.
5. **D/T range filter.** `CachesQuery` and `PlanInput.hardFilters` gain optional
   `difficulty` / `terrain` `{min, max}`; the caches repository applies them as
   `BETWEEN` predicates (no index needed — they narrow an already spatially
   bounded set). The search panel gets the matching control.
6. **System presets** (seeded, read-only, duplicable): *Quick traditionals*,
   *Forest walk*, *Adventure Lab day*.
7. **UI.** Profiles are managed on the Account page (list, create, edit,
   copy, delete) with the shared settings form; the planner's *Find caches* step
   gets a profile picker and "Save as profile".
8. **API.** `GET /route-profiles` (system + own), `POST /route-profiles`,
   `PUT /route-profiles/:id`, `DELETE /route-profiles/:id` (own rows only;
   a system or foreign id is 404). Authenticated + CSRF like every mutation; not
   in the `@Public()` set.

## Alternatives considered

- **Keep profiles in localStorage.** Rejected: they wouldn't follow the user
  across devices, and the walk is used on a phone while profiles are best edited
  on a desktop.
- **One column per setting.** Rejected: ~20 columns that churn with every planner
  feature; the settings are only ever read and written as a whole, and zod already
  validates them. JSONB + a versioned schema keeps migrations for real structural
  changes only.
- **Extend `landuse_profiles`.** Rejected: it is a scoring sub-preference
  referenced by `landuseProfileId`; a route profile *references* one rather than
  replacing it.
- **Store the full `PlanSettings` / `SearchParams` objects.** Rejected: they
  include the search centre and display toggles, and tie the stored format to
  UI state refactors. A separate schema with a one-to-one mapping gives the same
  coverage with a stable stored format.
- **Profiles describe only "the kind of walk"** (the first draft of this ADR:
  no radius, parking or expert tuning; walk-only fields without effect in the
  planner). Rejected by the owner in favour of full parity, so a profile is a
  complete, reusable planner setup and every setting means the same thing in
  both places.

## Consequences

**Good**
- Named setups that sync across devices; one tap in the field for FR-T18.
- The planner and profiles can't drift: one form, one-to-one mapping, a
  round-trip test over every field.
- The cluster planner gains a D/T range filter, variety and preferred-type
  ranking, per-type visit times and a real time budget on both paths.

**Trade-offs**
- Planner time is now `metres ÷ walking speed + visits` everywhere: the solver's
  travel seconds are pace-derived instead of OSRM's fixed foot-profile seconds
  (they only matter for the time budget).
- The time budget is applied in Pass 2 only; Pass-1 ranking still uses the
  distance budget (`budgetFit`).
- Two sources of the "current" settings (profile vs. edited local settings):
  handled by the explicit "modified" state rather than auto-sync.
