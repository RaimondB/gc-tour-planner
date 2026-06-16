# Requirements — Web app / PWA

Installability and platform-integration requirements for the web client. The app
is a Progressive Web App: installable to a phone home screen, launching
standalone, with native share and offline access to already-viewed saved tours.
See [design/frontend.md](../design/frontend.md) and
[ADR-0028](../adr/0028-pwa-installability-offline-and-native-share.md).

- **FR-W1 (installable PWA).** The app ships a web manifest (name, icons incl. a
  maskable variant, `theme_color`, `display: standalone`, `start_url: /`) and a
  service worker that precaches the app shell, so a supporting browser offers
  **Install** and the installed app launches standalone with its own home-screen
  icon. The app is **not** offline-capable for planning — discovery/planning need
  the live API + OSRM. A new deploy surfaces an unobtrusive **"update available —
  reload"** prompt (the `prompt` update strategy), never a silent mid-session
  swap. The running app polls for a newer service worker on an interval and on
  regaining focus, so the prompt appears live rather than only after a restart.
  Icons and manifest are self-hosted (no external CDN). An in-app
  **Install** prompt (driven by `beforeinstallprompt`) offers installation
  directly, instead of relying solely on the browser's menu; it hides once the
  app is installed or already running standalone (and never appears on iOS,
  where install is Safari's Share → Add to Home Screen). [ADR-0028]
- **FR-W2 (native GPX share with download fallback).** GPX export offers the OS
  share sheet via `navigator.share({ files })` when the platform accepts the
  file (`navigator.canShare`), and otherwise falls back to the existing anchor
  download. A user dismissing the sheet is respected (no forced download); any
  share failure falls back. The download path remains the guaranteed one, since
  Chrome's Web Share allowlist frequently rejects `.gpx`
  ([see download-text.ts](../../apps/web/src/lib/download-text.ts)). [ADR-0028]
- **FR-W3 (offline saved tours).** A saved tour that has been opened online while
  installed is viewable **offline** — route, pins, parking, totals — and
  exports/shares GPX offline. The service worker caches the saved-tour reads
  (`GET /tours`, `GET /tours/:id`, `GET /tours/:id/preview`) stale-while-revalidate;
  tour data and GPX are built client-side from the stored plan, so neither needs
  the network. Map **tiles are deliberately not cached** (OSM's tile policy
  forbids downloading tiles for offline use): when basemap tiles can't load, the
  app shows the tour's stored snapshot (FR-W4) instead of the live map; when
  tiles do load (online, or from the browser's normal HTTP cache) the live,
  pannable map is shown. A tour never opened online does not render offline. The
  session probe `GET /auth/me` is cached **network-first** so an offline launch
  keeps the last-known user and reaches the cached tours, instead of bouncing to
  a login that can't complete offline. [ADR-0028]
- **FR-W4 (map snapshot).** On save, the client captures a WebP snapshot of the
  tour's map (basemap + route overlay) and uploads it (`PUT /tours/:id/preview`,
  owner-scoped, ≤512 KB). It serves two purposes: the **thumbnail** in the My
  Tours list, and the **offline fallback** shown in place of the live map when
  offline. Offline is determined by an **authoritative connectivity probe**
  (`GET /api/health`, a `NetworkOnly` endpoint the SW won't answer from cache),
  re-checked on the browser online/offline events, on tab focus, periodically,
  and immediately when basemap tiles fail — not the unreliable `navigator.onLine`
  and not tile-render success (a cached tile is indistinguishable from being
  online). As an OSM-derived Produced Work the snapshot carries OSM attribution
  when displayed. Tours saved before this feature backfill their snapshot on the
  next online open. Capture is best-effort: it requires the tile host to send
  CORS headers (else the WebGL canvas is tainted and capture is skipped) and
  never blocks the save. [ADR-0028]
