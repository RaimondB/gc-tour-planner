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
3. **What a profile contains** (owner-chosen: objective weights, cache filters,
   time model, default duration — plus Adventure Lab handling):

   | Group | Field | Classic planner | Ad-hoc walk |
   | --- | --- | --- | --- |
   | `filters` | `types[]` (empty = any), `multiSubtype`, `hideToolCaches`, `solvedMysteriesOnly`, `contexts[]` (landuse hard filter) | → search filters | candidate pool |
   | | `difficulty {min,max}`, `terrain {min,max}` (1–5, **new filter**) | → search + discovery hard filter | candidate pool |
   | | `includeAdventureLabs` | → `includeAdventuresInClustering` | candidate pool |
   | | `excludeSavedTourCaches` | → discovery toggle (FR-T16) | candidate pool |
   | `adventures` | `keepTogether` | → `completeAdventuresOnly` | whole adventure or none |
   | | `interleave` | → `adventureInterleave` | stages may interleave |
   | `objective` | `landuseProfileId`, `landuseWeight` | → cluster landuse term | per-cache scenic prize |
   | | `varietyWeight`, `preferredTypes[]`, `preferredWeight` | not used yet (Pass 1/2 have no such terms) | per-cache prize |
   | `time` | `visitMinutes`, `alStageVisitMinutes`, `toolBonusMinutes`, `walkingKmh` | → tour settings | dwell + pace |
   | | `visitMinutesByType` (per-type overrides) | not used (uniform visit time) | per-type dwell |
   | | `bufferMinutes` | — | safety margin before the deadline |
   | `budget` | `distanceBudgetMeters` | → distance budget | — |
   | | `defaultDurationMinutes` (nullable) | — | prefilled walk duration |

   Deliberately **not** in a profile: the search area (center/radius), map
   display toggles, parking preferences, centre bias, and expert clustering
   tuning (strategy, min size, max link, top-N, fringe trim) — those describe
   *where* and *how the algorithm runs*, not *what kind of walk*.
4. **Applying a profile in the classic planner is client-side**: a pure
   `applyRouteProfile(profile, search, planSettings)` maps the settings onto the
   existing `SearchParams` / `PlanSettings`, and `profileFromCurrent(...)` builds
   one back for "Save current settings as profile". No new `PlanInput` /
   `PlanLoopInput` fields beyond the D/T filter (ADR-0002 holds). The selected
   profile id is remembered on-device (`gctp:route-profile-id`); editing a setting
   afterwards marks the selection "modified" — it never silently writes back.
5. **D/T range filter.** `CachesQuery` and `PlanInput.hardFilters` gain optional
   `difficulty` / `terrain` `{min, max}`; the caches repository applies them as
   `BETWEEN` predicates (no index needed — they narrow an already spatially
   bounded set). The search panel gets the matching control.
6. **System presets** (seeded, read-only, duplicable): *Quick traditionals*,
   *Forest walk*, *Adventure Lab day*.
7. **UI.** Profiles are managed on the Account page (list, create, edit,
   duplicate, delete); the planner sidebar gets a profile picker and "Save as
   profile".
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
- **Store the full `PlanSettings` / `SearchParams` objects.** Rejected: they mix
  in area, display and expert tuning; a profile should describe the walk, and a
  separate schema decouples it from UI state refactors.

## Consequences

**Good**
- Named setups that sync across devices; one tap in the field for FR-T18.
- The classic planner gains a D/T range filter.
- No planner-interface change: the mapping is client-side.

**Trade-offs**
- Variety / preferred-type weights and per-type visit times only take effect in
  the ad-hoc walk until Pass-1/Pass-2 scoring grows those terms (follow-up).
- Two sources of the "current" settings (profile vs. edited local settings):
  handled by the explicit "modified" state rather than auto-sync.
