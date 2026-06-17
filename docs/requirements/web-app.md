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
- **FR-W2 (reliable GPX download, incl. installed PWAs).** GPX export saves the
  file via a **service-worker-mediated download**: the client stages the GPX as a
  `Content-Disposition: attachment` response in a cache and a hidden iframe
  fetches it, so the file is saved with its filename. This is the only path that
  reliably saves a file inside Android "installed" PWAs — in-page anchor/blob
  `download` is silently swallowed there (notably Edge, whose install is a
  shortcut, not a true WebAPK), and it works **offline** (FR-W3). Because the
  installed PWA has no download shelf and Edge surfaces the OS download
  notification only in the shade, the app shows an **in-app confirmation toast**
  naming the saved file as the immediate feedback (the file is opened from the
  shade notification or a file manager — no web API can open the "open with"
  chooser for a `.gpx`). Filenames follow a short, recognisable convention
  (`gctp-[place-]<km>km-<n>c-<MonDD>-<mode>.gpx`). It falls back to the anchor
  download when no SW controls the page (first load, unsupported browser, dev). Web Share is **not** used: Chromium's allowlist
  rejects `.gpx`/`application/gpx+xml` outright (extension **and** MIME), so a
  real `.gpx` can never go through the share sheet.
  ([lib/gpx-download.ts](../../apps/web/src/lib/gpx-download.ts),
  [lib/sw-download.ts](../../apps/web/src/lib/sw-download.ts)) [ADR-0032]
- **FR-W3 (offline saved tours).** A saved tour that has been opened online while
  installed is viewable **offline** — route, pins, parking, totals — and
  exports GPX offline. The service worker caches the saved-tour reads
  (`GET /tours`, `GET /tours/:id`, `GET /tours/:id/preview`) stale-while-revalidate;
  tour data and GPX are built client-side from the stored plan, and the GPX
  download itself is SW-mediated (FR-W2), so neither needs the network. Map **tiles are deliberately not cached** (OSM's tile policy
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
