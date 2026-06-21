---
name: frontend-pwa-offline
description: Traps and rules for the gc-tour-planner web client's PWA, service worker, HTTP caching, offline behaviour, and cross-route React state. Use BEFORE touching vite-plugin-pwa/workbox config, nginx cache headers, PWA icons, the connectivity/offline UI, MapLibre layers, auth/session status, or any state that must survive navigation/reload — and when a "works in dev but not installed/offline/other-browser" bug appears.
---

# PWA / offline / caching / frontend-state — don't re-step on these

Authoritative rationale: [ADR-0029](../../../docs/adr/0029-frontend-offline-resilience-caching-and-state.md)
(+ [ADR-0028](../../../docs/adr/0028-pwa-installability-offline-and-native-share.md)).
Each rule below is a real incident that cost UAT round-trips.

## Service worker (vite.config.ts → VitePWA workbox)

- **`navigateFallbackDenylist` must exclude every path the origin/edge/SW owns** —
  currently `[/^\/api\//, /^\/cdn-cgi\//, /^\/_gpx\//]`. `/cdn-cgi/*` is
  Cloudflare's reserved space (Access login callback `/cdn-cgi/access/authorized`).
  `/_gpx/*` is the SW-mediated GPX download (below). If the SW answers such a
  navigation with the precached `index.html`, the SPA renders "Not Found", the
  request never reaches its real handler, and auth/edge/download flows dead-end.
  Adding any new auth-callback, edge, or SW-owned path? Add it here in the same PR.
- **GPX download is SW-mediated, NOT an in-page anchor/blob ([ADR-0032]).**
  In-page `<a download>`/blob downloads are silently swallowed inside Android
  "installed" PWAs (Edge especially — its install is a shortcut, not a true
  WebAPK): nothing downloads, nothing surfaces. Web Share can't carry a `.gpx`
  either (Chromium's allowlist rejects the extension AND the MIME). The working
  path: the client stages the GPX as a `Content-Disposition: attachment`
  `Response` in the `gpx-downloads` Cache, then points a **hidden iframe** (NO
  `download` attr) at `/_gpx/<id>/<name>`; a workbox `CacheFirst` route (cacheName
  **`gpx-downloads`**, used verbatim — must equal the client's `caches.open`)
  serves it, so the file is saved (filename kept, works offline). The download is
  **silent by platform** — Edge's installed PWA shows the OS download
  notification only in the shade, and a top-level navigation (which does route
  through DownloadManager) just adds a shell "flash" for no real gain. So we give
  feedback **in-app** instead: `GpxDownloadToast`, a **pure confirmation** ("Saved
  `<file>`") fired via `emitGpxSaved` on the SW save path. Don't add an "open"
  action — there is NO web way to open the OS Downloads UI or the "open with"
  chooser for a `.gpx` from Edge's PWA (intents are sandboxed, Web Share rejects
  `.gpx`, `window.open` just re-downloads). Filenames follow
  `gctp-[place-]<km>km-<n>c-<MonDD>-<mode>.gpx` (`lib/tour-filename.ts`) so the
  toast + Downloads folder are scannable.
  **No `download` attribute** anywhere — that's the in-page blob path Edge's PWA
  swallows. Don't "simplify" this back to an in-page anchor download. The blob
  anchor path
  (`download-text.ts`, with its **deferred** `revokeObjectURL` — never revoke
  synchronously) survives only as the no-SW fallback.
- **Offline only works in a production build.** `devOptions.enabled:false` keeps
  the SW out of `pnpm dev`. Verify with `pnpm --filter @gctp/web build` then
  preview, DevTools → Network → Offline. After deploy, a stale SW persists
  (`prompt` strategy) until the user clears site data / reinstalls.
- Symptom decoder: *"works in another browser / Edge but not Chrome", or "the
  origin log shows zero requests"* → suspect the SW serving from cache. Grab a
  Chrome trace / DevTools → Application → Service Workers.

## Install / update UI + iterating on its layout

- **Install is a menu item, never a toast.** `PwaInstallProvider` captures
  `beforeinstallprompt` once *above the router* and exposes `usePwaInstall()`
  (`canInstall`/`promptInstall`); `App.tsx` renders it as a desktop header button
  and an "Install app" hamburger item so it can't cover the map. Don't bring back
  a bottom install toast. The "update available" toast stays (lifecycle in
  `PwaUpdatePrompt`, view split into `pwa-update-toast.tsx`), but on mobile it's a
  full-width, safe-area-aware bottom bar, not a centred pill.
- **Validate these layouts by screenshot without the full stack.** The dev visual
  harness `apps/web/dev/pwa-preview.html` (entry `dev/pwa-preview.tsx`) renders
  the header/menu + update bar with the real CSS — no API, auth, or SW. Run
  `pnpm --filter @gctp/web dev`, then
  `node apps/web/scripts/shoot-pwa-preview.mjs` (override `PREVIEW_URL` if Vite
  picked another port) to capture mobile (360/390) + desktop PNGs in `/tmp/pwa-shots`.
  The harness header markup mirrors `App.tsx` — keep it in sync when the header
  changes. It's dev-only (not a build input), so it never ships.

## Caching headers (infra/nginx.conf)

- **Stable-named files are never `immutable`.** Only Vite's content-hashed
  `assets/*-[hash].*` get `immutable`. `/icons/*`, `/apple-touch-icon.png`,
  `sw.js`, `manifest.webmanifest` → `no-cache`.
- **Changed a PWA icon's pixels? Bump `?v=N`** on the manifest icon `src`s and
  the `apple-touch-icon` href (vite.config.ts / index.html). The installed
  WebAPK icon is keyed on the URL; `no-cache` refreshes the browser HTTP cache
  but does **not** re-mint the WebAPK. Maskable safe zone: keep glyphs inside the
  central ~66% (Samsung/Edge crops tighter than Chrome).
- **Two icon intents + per-env variants (ADR-0031).** `icon-maskable.svg` is
  FULL-BLEED (cropped home-screen icon + iOS apple-touch); `icon-source.svg` is a
  ROUNDED tile (shown in full on the splash). `VITE_APP_ENV` (default `uat`) picks
  the `-uat` badged icons + "(UAT)" name; prod sets `production`. Resolver in
  `src/lib/app-identity.ts`, consumed by `vite.config.ts` (manifest +
  `transformIndexHtml` for title/apple-touch). Render PNGs with `rsvg-convert` per
  the SVG headers, then bump `?v`.

## Cross-route / must-survive state

- **One owner, above the router.** State that must survive navigation or reload
  (the opened tour) lives in a context provider mounted **above** `RouterProvider`
  (`TourSessionProvider`), with explicit transitions (`openTour`/`closeTour`) —
  not smeared across `useState` + mount effects, and **not** passed via router
  history state (that remounts the app and races).
- **Persist on intent, not on success**, and persist the durable payload in
  IndexedDB (`lib/tour-cache.ts`) with a small localStorage pointer; React Query
  is the fetch/cache layer. A slow/failed fetch must not leave the wrong item
  resuming.
- Global store still banned (CLAUDE.md): TanStack Query + URL params + these
  scoped providers. A provider for one concern ≠ a global store.

## Auth / connectivity / map lifecycle

- **Never derive auth status from `online`.** An errored `/auth/me` keeps the
  last-known user; only a clean `401 → null` logs out. A connectivity probe must
  never flip identity (it caused a startup route-bounce → map teardown → crash).
- **Edge auth (Cloudflare Access) vs the SW — "shows offline instead of the
  login".** The SW serves the precached shell for navigations (`navigateFallback`),
  so when the Access session lapses the Access *challenge* on `/` never reaches the
  edge: the app boots unauthenticated, every `/api/*` (incl. the `/api/health`
  probe) is redirected cross-origin, and a default `fetch` follows it into a CORS
  error → indistinguishable from offline. Fixes: probe with `redirect:"manual"` so
  the redirect surfaces as `type:"opaqueredirect"` (classify as `"auth"`, not
  offline — `use-connectivity.ts#classifyProbe`); show a reconnect gate
  (`SessionExpiredGate`) whose action **unregisters the SW then reloads** (a plain
  reload is re-served from cache and never reaches Access). Reconnect by escaping
  the SW, not by hitting a Cloudflare-specific URL.
- **MapLibre ops are lifecycle-guarded.** Gate on the `ready`/`load` flag; never
  `map.getSource`/`getLayer` on a removed/not-loaded map (`… reading 'getSource'
  of null`). Unbind event/async handlers on cleanup.
- **WebGL context loss nulls `map.style` while the map stays mounted — THIS is
  the recurring `reading 'getLayer' of null` crash (`#78`, and again post-#84).**
  When an installed PWA is backgrounded and the OS reclaims the GPU, MapLibre's
  `webglcontextlost` handler runs `this.style.destroy(); this.style = null` but
  the `Map` object lives on and `MapView` stays mounted with `ready: true`. On
  **app refocus** a re-render (React Query refetch-on-focus, connectivity probe,
  `recover()`) re-runs a layer effect; its `map.getLayer(id)` is
  `this.style.getLayer(id)` → throws on the null style → the recoverable error
  screen. It is NOT an auth/route-bounce/unmount bug (that was a red herring —
  both reported crashes resolved to the *same* `WalkingGraphLayer:126` effect
  body via the deployed sourcemap; resolve the bundle frame, don't guess). Fix
  (two parts, both central — no per-layer edits, because every layer effect
  already opens with `if (!ready) return` and every `return () =>` cleanup only
  does `map.off`):
  1. `MapContext.isMapStyleLive(map)` = `Boolean(map.style)`; `useMap()` returns
     `ready: false` when the style is gone, so a focus re-render makes every
     layer bail.
  2. `MapView` listens for `webglcontextlost` (→ `ready:false`) /
     `webglcontextrestored` (→ `ready:true` + resize/repaint) to drive the
     re-render deterministically and re-add layers on restore.
  `isMapStyleLive` also covers the removed-map case. (`MapView.test.tsx` locks it
  — fails with the literal `reading 'getLayer'` when the gate is removed.)
  3. **Blank-canvas variant — `webglcontextrestored` NEVER fires.** On an
     installed PWA backgrounded long enough for the OS to reclaim the GPU, the
     browser often discards the context for good: `webglcontextlost` fires (style
     nulled) but `webglcontextrestored` never does, so MapLibre's saved
     `_lostContextStyle` is never re-applied — `recover()`'s resize/repaint is a
     no-op against a null style and the map is **blank until a full reload** (the
     reported symptom). Fix: `MapView` recreates the map from scratch
     (`recreateKey` state bumps + a `key`ed container div so the deferred old
     `map.remove()` can't race the new instance) when it detects a dead style on
     **refocus** (`visibilitychange`/`focus`/`pageshow` → `recover` →
     `recreateIfDead`) or via a 1.5 s post-loss timer for the foreground case.
     It reopens at the last camera (`cameraRef`, stashed on `moveend`; `getCenter`
     survives a dead style). Guard with `isMapStyleLive` so a *healthy* restore
     stays the cheap repaint path — never recreate a live map (would thrash tiles).
     `MapView.test.tsx` locks both: recreate-on-dead-refocus, and no-recreate when
     the context restores normally.
- **Teardown order (secondary/defensive).** React runs effect cleanups
  **parent-first** on unmount, so `MapView`'s cleanup fires before each child
  layer's; a synchronous `map.remove()` there would null `map.style` before the
  children clean up. No current layer cleanup touches the style (all are
  `map.off`), so this is latent — but `MapView` still **defers `map.remove()` one
  `queueMicrotask`** so a future getLayer-in-cleanup can't regress. Don't
  reintroduce a synchronous `map.remove()`.
- The router has a **recoverable** `defaultErrorComponent` (Reload / Try again +
  stack). Keep it; don't regress to a dead-end error screen.

## Marketing page parity

- Shipped a user-visible feature change? Update the landing page
  (`apps/web/src/features/landing/LandingPage.tsx`, route `/welcome`) in the same
  PR. It's on the PR docs checklist and in [docs-policy](../../../docs/sdlc/docs-policy.md).

## Every fix ships a regression test

Same rule as everywhere ([test-levels](../test-levels/SKILL.md)): lock the bug at
the lowest level that reproduces it. SW/WebAPK/edge behaviour isn't reachable in
jsdom — assert the *config* (e.g. the denylist regex, the `?v=` on manifest
srcs, the nginx `no-cache` location) and the React layer (provider transitions,
auth-status stability), and verify the SW/offline behaviour manually in a prod
build.
