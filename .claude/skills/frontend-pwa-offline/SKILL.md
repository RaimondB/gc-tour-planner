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
- **Teardown order: the `ready` gate is NOT enough.** React runs effect cleanups
  **parent-first** on unmount, so `MapView`'s cleanup fires *before* every child
  layer's. If `MapView` calls `map.remove()` synchronously, `remove()` nulls
  `map.style`, then each child layer's cleanup runs `map.getLayer(id)` /
  `removeLayer` on the dead map and throws `Cannot read properties of null
  (reading 'getLayer')` — the route bounces to the recoverable error screen. This
  is the same defect #78 saw as `getSource`; #78 only removed one *trigger* of the
  unmount. The fix lives in `MapView`: **defer `map.remove()` one `queueMicrotask`**
  so every child cleanup still sees a live map. Don't reintroduce a synchronous
  `map.remove()` in the cleanup. (`MapView.test.tsx` locks it.)
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
