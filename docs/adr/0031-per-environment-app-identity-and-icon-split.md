# ADR-0031 — Per-environment app identity and split display/maskable icons

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0028](0028-pwa-installability-offline-and-native-share.md) / [ADR-0029](0029-frontend-offline-resilience-caching-and-state.md) (PWA/offline/icons), [ADR-0030](0030-cloudflare-web-analytics.md) (build-arg pattern), [CLAUDE.md hard rules](../../CLAUDE.md) (PWA `?v=N` bump), skill [`frontend-pwa-offline`](../../.claude/skills/frontend-pwa-offline/SKILL.md)

## Context

Two PWA pain points, fixed together because both touch the icon pipeline:

1. **UAT and prod were indistinguishable when installed.** Both are installed
   PWAs (on separate origins) with the same name ("GC Tour" / "gc-tour-planner")
   and the same icon, so it was easy to act on the wrong install. (They are
   already fully isolated at runtime — service worker, Cache Storage, IndexedDB,
   cookies, and the WebAPK are all partitioned per origin — so this is purely a
   *human* recognisability problem.)
2. **One icon design can't serve both display roles.** The home-screen icon is
   **cropped** by the launcher's circle/squircle mask (needs full-bleed art so the
   mask only rounds solid colour — the hard-won rule from ADR-0028), while the
   **splash** icon is shown **in full** (a full-bleed hard-edged square looks
   unfinished on the white splash). A single full-bleed source was reused for both.

## Decision

**Introduce an explicit `VITE_APP_ENV` build arg and split the icon sources into a
full-bleed *maskable* set and a rounded *display* set, each with a prod and a
badged UAT variant.**

- **`VITE_APP_ENV` (public build arg, values `production` | `uat`, default
  `uat`).** Follows the Turnstile/analytics-token pattern (Dockerfile.web →
  docker-compose → build). Default `uat` is fail-safe: anything not explicitly
  `production` shows the UAT badge. The prod host's untracked `.env` sets
  `VITE_APP_ENV=production` (alongside `NODE_ENV=production`). A pure, unit-tested
  resolver (`apps/web/src/lib/app-identity.ts`) maps it to `{ name, shortName,
  title, iconSuffix }`; `vite.config.ts` consumes it for the manifest `name`/
  `short_name`, the env-suffixed icon `src`s, and (via a small `transformIndexHtml`
  plugin) the `<title>`, `apple-mobile-web-app-title`, and `apple-touch-icon` href.
  UAT names get a `" (UAT)"` suffix; UAT icons use the `-uat` files.

- **Two icon intents.**
  - **Maskable / full-bleed** (`icon-maskable.svg`) → `pwa-maskable-512.png`
    (`purpose: "maskable"`) **and** `apple-touch-icon.png` (iOS rounds it itself,
    so full-bleed is correct). The cropped home-screen icon.
  - **Display / rounded tile** (`icon-source.svg`, now a rounded-corner inset
    tile) → `pwa-192.png` / `pwa-512.png` (`purpose: "any"`). Shown in full on the
    splash and on non-masking launchers.
  - UAT variants (`*-uat.svg` → `*-uat.png`) add a centred dark **"UAT" pill**
    sized to sit inside the central-66% safe circle, so the launcher's circular
    crop never removes it.

- **Icons stay hand-rendered + committed.** `rsvg-convert` from the SVG sources
  (commands in each SVG header); PNGs committed as binaries; **`?v` bumped 3 → 4**
  because the prod display icons + apple-touch bytes changed (WebAPK is keyed on
  the URL). nginx keeps every stable-named icon (incl. `-uat`) `no-cache`.

## Consequences

- **Positive.** An installed UAT PWA is unmistakable (badged icon + "(UAT)" name +
  browser-tab title); prod is unchanged in name and gets a tidier splash icon. The
  env signal is explicit and first-class (no more inferring environment from the
  analytics-token presence), and reusable for future per-env tweaks.
- **Cost / risk.**
  - Rounding the `any` display icons reintroduces a small double-mask risk on
    legacy launchers that mask an `any` icon — accepted because modern
    Chrome/Android uses the `maskable` icon for the launcher when present, so the
    `any` icon is only ever shown unmasked (splash).
  - Two icon sets to maintain; the SVG headers document the render commands.
  - Pill geometry / rounded inset are tuned by eye on a device (PWA behaviour is
    only verifiable in a prod build, per the skill).
- **Dev** (`pnpm dev`, `VITE_APP_ENV` unset) shows the UAT identity — expected.

## Alternatives considered

- **Reuse the analytics-token presence as the env signal.** Conflates two
  concerns — prod without analytics, or UAT temporarily enabling it to test, would
  flip the badge wrongly. An explicit `VITE_APP_ENV` is correct.
- **One icon for both roles (status quo).** Either the splash looks like a hard
  square or the home icon double-masks. The split is the standard fix.
- **Runtime in-app environment banner only.** Doesn't help when choosing which
  installed PWA to open from the home screen — the icon/name is what's visible there.
