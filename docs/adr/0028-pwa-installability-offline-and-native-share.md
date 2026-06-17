# ADR-0028 — PWA installability, offline saved tours, and native GPX share

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Raimond Brookman (owner)
- **Related:** [FR-W1–W4](../requirements/web-app.md), [ADR-0027](0027-icon-system-lucide.md) (no-CDN, self-hosted assets), [ADR-0022](0022-tour-sharing-link-security.md) (saved-tour snapshot), [CLAUDE.md hard rules](../../CLAUDE.md) (GPLv3-compatible deps; OSM attribution)

## Context

The web client was a plain SPA: no manifest, no service worker, no installable
icons. Two user-facing wants motivated change — a phone home-screen icon /
standalone launch, and sharing a tour's GPX straight to the OS share sheet — plus
a follow-on: viewing already-saved tours **offline** (in the field, with patchy
signal).

Three facts constrained the design:

1. **Planning can't go offline.** Cluster discovery and routing need the live API
   and self-hosted OSRM. So "offline" can only mean *viewing already-fetched
   saved tours*, never planning.
2. **`.gpx` is unreliable in Web Share.** `apps/web/src/lib/download-text.ts`
   already documents that Chrome/Android exclude `.gpx`/`application/gpx+xml`
   from the Web Share file allowlist, and Garmin Connect registers only
   `ACTION_VIEW`. So native share must be additive, never replacing the working
   download.
3. **The basemap is remote raster, the overlays are app-drawn.** The route line,
   cache pins and parking are GeoJSON layers built from the stored plan (they
   render offline once the shell loads), but the basemap is remote raster PNG
   tiles (`MapView.tsx`) — not in the stored plan, and not bulk-prefetchable
   (OSM's tile policy forbids it).

## Decision

**Make the web app an installable PWA via `vite-plugin-pwa` (+ workbox), add a
feature-detected native GPX share with download fallback, cache saved-tour reads
for offline viewing, and capture a client-side map snapshot per saved tour for
the offline basemap and list thumbnail.**

- **Installability (FR-W1).** `vite-plugin-pwa` (MIT) + `workbox-window` (MIT) —
  both GPLv3-compatible. Web manifest + self-hosted PNG icons (192/512 + maskable
  512, rendered from the brand monogram; no CDN) + a generated service worker
  that precaches the app shell. SW registered via `virtual:pwa-register/react`
  with the **`prompt`** update strategy — a "new version available" toast, not a
  silent mid-session swap (which could break a lazily-loaded chunk). nginx serves
  `sw.js` and `manifest.webmanifest` with `Cache-Control: no-cache` so deploys
  are picked up (the broad `immutable` asset rule would otherwise pin a stale SW
  for 30 days).
- **API caching (FR-W3).** `NetworkOnly` for `/api/*` (no useful stale answer),
  except the saved-tour reads (`/tours`, `/tours/:id`, `/tours/:id/preview`,
  UUID-anchored so the `/tours/{clusters,plan,…}` planning endpoints are
  excluded) which use `StaleWhileRevalidate`, and `GET /auth/me` which uses
  `NetworkFirst` (a live session always wins, but an offline launch falls back to
  the last-known user instead of bouncing to a login that can't run offline). The
  SW caches the response body; it never needs the httpOnly session cookie. Tour
  data + GPX are built client-side from the stored plan, so an opened tour renders
  and exports offline with no API change. Map **tiles are not cached by the SW** —
  OSM's tile policy forbids downloading tiles for offline use — so the offline map
  falls back to the stored snapshot (see below).
- **Native share (FR-W2).** `lib/share-file.ts#shareOrDownloadGpx` builds a
  `File`, calls `navigator.share` when `navigator.canShare({ files })` accepts
  it, and falls back to `downloadText` on any unsupported/failed case. A
  user-cancel (`AbortError`) is respected.
- **Parking navigation hands off natively (offline-capable).** The "Navigate to
  parking" link (`lib/maps.ts#parkingNavTarget`) emits a **native OS map-intent
  URI** per platform — `google.navigation:q=lat,lng` (Android, direct turn-by-turn)
  and `maps://?daddr=lat,lng&dirflg=d` (iOS, Apple Maps) — which the OS resolves
  *without network* and routes to the installed maps app, where downloaded offline
  maps take over. Desktop keeps the shareable Google Maps web URL
  (`https://www.google.com/maps/dir/?api=1&destination=…`, `googleMapsDirUrl`). The
  earlier web-URL-everywhere link dead-ended offline: the browser couldn't reach
  `google.com`, and from the installed PWA it wouldn't reliably hand off to the
  maps app. Only the http(s) desktop URL opens with `target="_blank"` — custom app
  schemes must not (a blank tab that never closes).
- **Map snapshot (FR-W4).** On save, the client captures the rendered canvas
  (`map.getCanvas().toBlob(…, "image/webp")`, needing `preserveDrawingBuffer`)
  and uploads it to `PUT /tours/:id/preview`; it's stored in a `bytea` column and
  served from `GET /tours/:id/preview` (owner-scoped, not `@Public()`). It is the
  My Tours list thumbnail AND the offline map fallback: shown in place of the live
  map when offline. Offline is decided by an **authoritative connectivity probe**
  (`GET /api/health`, NetworkOnly) — not `navigator.onLine` (reports "online" with
  an interface but no connectivity) and not tile-render success (a cached tile is
  indistinguishable from being online; an earlier tile-based version flapped
  during pan/zoom). The probe re-runs on online/offline events, tab focus,
  periodically, and the moment tiles fail (a fast nudge). As an OSM-derived
  Produced Work the snapshot carries OSM attribution when shown. Capture is
  best-effort and non-fatal.

## Consequences

- **Positive.** Installable to a home screen, standalone launch. Native share
  where the platform supports it, with zero regression to download. Saved tours
  open offline with a real map picture, route data, and working GPX. No new
  always-on infra; everything is build-time (SW) or a single `bytea` column.
- **Cost / risk.**
  - `preserveDrawingBuffer: true` adds a small always-on GPU/memory cost to the
    map (required to read pixels).
  - Snapshot capture throws `SecurityError` on a CORS-tainted canvas, so the
    **production tile/style host must send CORS headers**; capture is wrapped and
    degrades to a blank offline basemap rather than breaking saves.
  - Private tour data (and snapshots) now sit in the on-device SW cache —
    acceptable for a personal app; noted for awareness.
  - Edits made elsewhere appear only after the SWR revalidation when back online.

## Alternatives considered

- **A native app (React Native / Capacitor).** An order of magnitude more effort,
  app-store pipelines, and GPLv3-vs-store-terms friction — for capabilities this
  app doesn't need (no offline planning either way). Both wants are native PWA
  capabilities. Capacitor can still wrap this PWA later if a store presence is
  ever needed, so PWA-first loses nothing.
- **`autoUpdate` SW.** Rejected — a silent swap can break a lazily-loaded chunk
  mid-session. `prompt` gives the user control.
- **Hand-rolled manifest + SW.** Kept as a fallback only if `vite-plugin-pwa`
  proved incompatible with Vite 8 (it didn't — 1.3.0 lists `vite ^8`).
- **Offline basemap by tile prefetch.** Bulk-prefetching OSM tiles violates their
  usage policy and costs heavy raster storage; only viable against a tile host we
  control. The per-tour snapshot gives an offline picture far more cheaply.
- **Full offline-first.** Pointless — planning needs the live API + OSRM.
