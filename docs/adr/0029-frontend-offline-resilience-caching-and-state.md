# ADR-0029 — Frontend offline resilience: caching, service-worker navigation, and single-source cross-route state

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0028](0028-pwa-installability-offline-and-native-share.md) (PWA install + offline saved tours), [ADR-0023](0023-staged-cloudflare-access-tunnel-removal.md) (Access gate in front of the app), [ADR-0027](0027-icon-system-lucide.md), [FR-W1–W4](../requirements/web-app.md), [architecture/frontend.md](../architecture/frontend.md). Agent checklist: [.claude/skills/frontend-pwa-offline](../../.claude/skills/frontend-pwa-offline/SKILL.md).

## Context

Shipping the installable PWA + offline saved tours (ADR-0028) surfaced a cluster
of bugs that all shared one root: **the service worker, the HTTP cache, and the
React state model each have lifecycle/edge cases that don't show up in a dev
build or a happy-path click-through.** They cost several round-trips to UAT to
diagnose. This ADR records the rules so they're not rediscovered the hard way.
Each rule below maps to a real incident.

1. **The SW navigation fallback hijacked an edge-owned path.** `navigateFallback`
   was denylisted for `/api/*` only. Cloudflare Access returns the browser to
   `/cdn-cgi/access/authorized?nonce=…` to set its session; the SW intercepted
   that navigation, served the precached `index.html`, the SPA matched no route
   and rendered "Not Found", and the Access cookie was never set — so Google
   sign-in dead-ended **and the request never reached the origin** (origin logs
   were empty; only a non-SW browser worked). Misread as a Cloudflare/Google
   problem for a while.
2. **Stable-named assets served `immutable` pinned stale copies.** PWA icons have
   fixed filenames but were caught by the broad `Cache-Control: public, immutable`
   30-day rule (meant for Vite's content-hashed assets). New icons shipped on
   every deploy but clients — and the installed WebAPK — kept the first one.
3. **Cross-route state smeared across hooks raced on startup.** The opened tour
   lived in four `useState`s plus a persisted id, was reset in 6+ places, and was
   handed between `/tours` and `/` via router **history state** that unmounted /
   remounted the app. Three coordinating mount effects then raced; switching
   tours offline lost context, and persisting on fetch *success* left the wrong
   tour resuming after a failed/slow open.
4. **Auth status derived from connectivity flipped mid-startup.** The offline
   fallback was gated on `online` (`isError && !online`). The periodic
   `/api/health` probe flipping `online` while `/auth/me` was still erroring
   dropped the fallback user → status flipped to unauthenticated → the `/` guard
   bounced to `/welcome` → the map unmounted mid-startup → a resumed layer touched
   the torn-down map and threw `Cannot read properties of null (reading
   'getSource')`, caught by the router's bare default error screen (a dead end).

## Decision

Adopt the following rules for the web client. They are normative; deviate only
with a follow-up ADR.

### Service worker

- **`navigateFallbackDenylist` must list every path the origin or edge owns**, not
  just `/api/*`. Today that is `[/^\/api\//, /^\/cdn-cgi\//]` — `/cdn-cgi/*` is
  Cloudflare's reserved space (Access login/callback, challenges). Any new
  edge-handled or auth-callback path is added here in the same PR. A navigation
  the SW must not answer locally is the litmus test.
- **`/api/*` is `NetworkOnly`** except the saved-tour reads
  (`StaleWhileRevalidate`) and `GET /auth/me` (`NetworkFirst`) — see ADR-0028.
- **Offline is only testable in a production build** (`pnpm --filter @gctp/web
  build && preview`); `devOptions.enabled:false` keeps the SW out of `pnpm dev`.
- **`prompt` update strategy** (ADR-0028) means a client can sit on a stale SW.
  Never rely on the SW updating itself to fix a broken flow in the field; design
  so a stale SW can't strand a critical path (rule above), and treat
  "clear site data / reinstall" as the test-time reset.

### Caching headers

- **Stable-named cacheable assets must not be `immutable`.** Only content-hashed
  files (Vite's `assets/*-[hash].js`) get `immutable`. Icons, `apple-touch-icon`,
  `sw.js`, and `manifest.webmanifest` are served `no-cache` so a redeploy is
  picked up.
- **The installed icon is keyed on the manifest URL, not just the bytes.** The
  browser's WebAPK minter caches by URL, so **bump `?v=N` on the manifest icon
  `src`s (and `apple-touch-icon`) on every icon byte change.** `no-cache` fixes
  the in-browser HTTP cache; it does not re-mint an installed WebAPK.

### State & lifecycle

- **One owner for cross-route state that must survive navigation/reload.** Mount a
  context **provider above the router** (e.g. `TourSessionProvider`) that owns the
  state and exposes explicit transitions (`openTour`/`closeTour`). Persist the
  durable payload (IndexedDB for heavy objects, a small localStorage pointer),
  use React Query for the fetch. Do **not** transport such state through router
  history + app remount, and do **not** coordinate it with several racing mount
  effects. Persist on **intent**, not on fetch success.
- **Never derive auth/session status from connectivity.** An errored `/auth/me`
  (network/5xx) keeps the last-known user; only a clean `401 → null` logs out.
  Connectivity (`useOnline`) gates *features*, never *identity*.
- **MapLibre access is lifecycle-guarded.** Gate every source/layer op on the map
  `load`/`ready` flag; never call `map.getSource`/`getLayer` on a removed or
  not-yet-loaded map (it throws `… of null`). Event/async handlers must be
  unbound on cleanup.
- **Recoverable error boundary.** The router's `defaultErrorComponent` offers
  *Reload* / *Try again* + the stack — a transient render/effect error is never a
  dead end, and is diagnosable in the field.

### Offline as a first-class app state

- One authoritative connectivity probe (`/api/health`) lifted into context
  (`useOnline`); an offline indicator + banner; online-only actions disabled with
  a stated reason; view/open/export of an already-loaded tour stay available.

### Marketing page parity

- The public landing page (`/welcome`, `apps/web/src/features/landing/LandingPage.tsx`)
  is part of the user-visible surface. When a shipped feature changes what the app
  offers, update it in the same PR (PR-template + [docs-policy](../sdlc/docs-policy.md)).

## Consequences

- **Positive.** Sign-in works behind the Access gate in every browser; icon and
  asset changes actually reach clients; opening/switching/resuming tours offline
  is reliable; a transient startup error is recoverable, not a white screen. The
  rules are a fast checklist (see the skill) rather than tribal knowledge.
- **Cost.** A few extra obligations per PR (bump `?v=`, extend the denylist, keep
  the landing page current) — all cheap, all enforced by the PR checklist.

## Alternatives considered

- **Content-hash the PWA icons** (instead of `?v=` + `no-cache`). Cleaner busting,
  but `vite-plugin-pwa` doesn't fingerprint `public/` assets and a custom hashing
  step wasn't worth it for a handful of icons. Revisit if icon churn grows.
- **`autoUpdate` SW** to avoid stale workers. Rejected in ADR-0028 (a silent swap
  can break a lazily-loaded chunk mid-session); the denylist + recoverable error
  boundary address the failure mode instead.
- **Keep tour state in `App` with effects.** That *was* the model; it raced. A
  provider-above-router with explicit transitions is the fix, not more effects.
