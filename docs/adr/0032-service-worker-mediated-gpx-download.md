# ADR-0032 — Service-worker-mediated GPX download (replaces in-page anchor/share)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Raimond Brookman (owner)
- **Related:** [ADR-0028](0028-pwa-installability-offline-and-native-share.md) (PWA install + the original share-with-download-fallback), [ADR-0029](0029-frontend-offline-resilience-caching-and-state.md) (SW/offline/caching), skill [`frontend-pwa-offline`](../../.claude/skills/frontend-pwa-offline/SKILL.md), [FR-W2/FR-W3](../requirements/web-app.md)

## Context

GPX export (the "Save to your GPS" buttons) produced the file in-page: build the
GPX string client-side, then either offer the Web Share sheet (ADR-0028 / the old
FR-W2) or click an `<a download>` blob anchor.

Two facts collapsed that design:

1. **Web Share can never carry a `.gpx` on Chromium.** Its file allowlist
   requires **both** the extension and the MIME type to be permitted, and
   `.gpx` / `application/gpx+xml` (and `xml` generally) are on neither list. So
   `navigator.canShare({ files: [gpx] })` is always `false` — the share path was
   dead code for our one file type, and every browser already fell through to the
   anchor download.
2. **The in-page anchor/blob `download` is silently swallowed inside Android
   "installed" PWAs.** Reproduced on Edge for Android, whose "install" is a
   home-screen **shortcut**, not a true WebAPK: tapping export does nothing — no
   download, no notification, nothing to open. Chrome's WebAPK happens to hand the
   blob to Android's DownloadManager fast enough to work; Edge's standalone
   context drops it. Deferring `URL.revokeObjectURL` (the classic
   revoke-too-early race) was necessary hygiene but did **not** fix it — the
   download never starts at all.

Constraint: it must also work **offline** (FR-W3 — exporting a saved tour's GPX
in the field), which rules out a server endpoint returning `Content-Disposition`.

## Decision

Stop producing the file in-page. **Have the service worker answer a navigation
with a `Content-Disposition: attachment` response**, so the browser routes it
through the OS download manager — a real, surfaced download (system
notification + tap-to-open, filename preserved) that works in every standalone
PWA and needs no network.

Implemented **config-only on the existing `generateSW`** — we do **not** migrate
to `injectManifest` or hand-write a SW, because that would mean re-implementing
the offline saved-tours caching and the Access-critical `navigateFallback`
denylist by hand (exactly the incident surface ADR-0029 warns about).

Mechanism:

1. Client (`lib/sw-download.ts`) builds a `Response(gpxText, { headers })` with
   `Content-Disposition: attachment; filename="…"`, `Content-Type`, and
   `X-Content-Type-Options: nosniff`, and `cache.put`s it under
   `/_gpx/<uuid>/<filename>` in the **`gpx-downloads`** Cache.
2. It points a **hidden iframe** at that path (no `download` attribute). The
   `attachment` response is saved without repainting the app shell.
   - A top-level navigation was tried instead — it does route through Android's
     DownloadManager (which raises a notification), but (a) it momentarily
     repaints the shell ("flash") and (b) Edge's installed PWA only shows that
     notification in the shade anyway. Net: not worth the flash.
   - Instead the app gives **immediate, in-app feedback**: on the SW save path,
     `downloadGpx` fires `emitGpxSaved` → `GpxDownloadToast` shows a **pure
     confirmation** ("Saved `<file>` to your downloads"), naming the file so it's
     recognisable. It is *not* actionable: there is **no web way to open the OS
     Downloads UI or the "open with" chooser for a `.gpx`** from Edge's standalone
     PWA — the Android `VIEW_DOWNLOADS`/`VIEW` intents are sandboxed away, and Web
     Share rejects `.gpx` (allowlist). The user opens the file from the shade
     download notification or a file manager (both fire the OS "open with"
     dialog). `window.open` on the file just re-downloads it — a dead end.
   - **Recognisable filename (`lib/tour-filename.ts`).** The saved name follows
     `gctp-[place-]<km>km-<n>c-<MonDD>-<mode>.gpx` (distance, cache count, date,
     track/route; OSM parking name prepended when known) so the toast and the
     Downloads folder are scannable — e.g. `gctp-bospark-8.3km-12c-Jun17-track.gpx`.
3. A workbox **`CacheFirst` route** for `/_gpx/*` (cacheName `gpx-downloads`)
   returns the staged Response verbatim → the browser downloads it.
4. `/^\/_gpx\//` is added to `navigateFallbackDenylist` so the SPA-shell
   `navigateFallback` never answers the download navigation instead.
5. Single-use: the client evicts the entry + removes the iframe after a delay; a
   short cache `expiration` self-cleans anything missed.

`lib/gpx-download.ts#downloadGpx` orchestrates: try `swDownload` first, fall back
to the anchor download (`lib/download-text.ts`, now with deferred revoke) when no
SW controls the page (first load, unsupported browser, dev). The Web Share path
is removed; `share-file.ts` → `gpx-download.ts`.

## Consequences

- **Reliable, openable downloads in installed PWAs**, online and offline, with
  the `.gpx` name intact — the reported Edge-for-Android failure is addressed at
  the OS-download-manager level rather than papered over in-page.
- **No SW rewrite.** Two declarative workbox changes (one denylist entry, one
  `CacheFirst` route) keep the offline/auth behaviour of ADR-0029 untouched. The
  cache name is used **verbatim** by workbox (no prefix), so the client's
  `caches.open("gpx-downloads")` and the route's `cacheName` are the same store —
  asserted by inspecting the generated `sw.js` at build.
- **Reflecting user content as a forced-download attachment is safe** — it is
  never rendered inline (`attachment` + `nosniff`); the filename is sanitised for
  header-injection.
- New SW-owned path `/_gpx/*` is now reserved. Like every edge/origin-owned path,
  it must stay on the denylist (see skill).
- Not unit-testable below the config/helper layer: the helper and the
  orchestrator have unit tests; the SW round-trip is verified manually in a prod
  build on-device (per ADR-0029's rule).
