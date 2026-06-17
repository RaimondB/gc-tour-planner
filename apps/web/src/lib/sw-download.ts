// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** Cache the SW serves `/_gpx/*` from — MUST match the workbox route in vite.config.ts. */
const CACHE_NAME = "gpx-downloads";
/** How long to keep the staged entry + anchor before cleanup. */
const EVICT_DELAY_MS = 60_000;

export interface SwDownloadOpts {
  text: string;
  filename: string;
  mimeType: string;
}

/**
 * Trigger a real, OS-surfaced file download through the service worker.
 *
 * In-page anchor/blob `download` is silently swallowed inside Android
 * "installed" PWAs (notably Edge, whose install is a home-screen shortcut, not
 * a true WebAPK): nothing downloads and nothing surfaces. Instead we stage the
 * GPX as a `Response` carrying `Content-Disposition: attachment` in a cache,
 * then point a **hidden iframe** at `/_gpx/<id>/<name>`; the workbox
 * `CacheFirst` route returns that Response verbatim, so the browser saves it
 * (filename preserved). No network → works offline.
 *
 * Why an iframe (not a top-level navigation): the top-level nav momentarily
 * repaints the app shell ("flash") before the `attachment` turns it into a
 * download — and its only upside, surfacing the OS download notification, is
 * moot because Edge's installed PWA shows that notification only in the shade
 * anyway. We give the user immediate, in-app feedback via a toast instead
 * (`GpxDownloadToast`, fired from gpx-download.ts), so the silent iframe save
 * is the cleaner path. We also deliberately omit the `download` attribute —
 * that's the in-page blob path Edge swallows.
 *
 * Returns `true` when the SW path was taken, `false` when it isn't available
 * (no controlling SW yet, unsupported browser, dev) — the caller then falls
 * back to the anchor download.
 */
export async function swDownload(opts: SwDownloadOpts): Promise<boolean> {
  const { text, filename, mimeType } = opts;

  if (
    typeof navigator === "undefined" ||
    !navigator.serviceWorker?.controller ||
    typeof caches === "undefined" ||
    typeof crypto === "undefined" ||
    typeof crypto.randomUUID !== "function" ||
    typeof document === "undefined"
  ) {
    return false;
  }

  const safeName = sanitizeFilename(filename);
  // The filename is also the URL's last segment: a belt-and-braces fallback so
  // the download is still named sensibly even if a browser ignores the header.
  const path = `/_gpx/${crypto.randomUUID()}/${encodeURIComponent(safeName)}`;

  const response = new Response(text, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      // Forced download, never sniffed/rendered inline — safe to reflect content.
      "X-Content-Type-Options": "nosniff",
    },
  });

  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(path, response);
  } catch {
    return false;
  }

  // Hidden iframe (NO `download` attr): the SW's attachment response is saved,
  // the app shell never repaints, and a misbehaving browser can't replace it.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.display = "none";
  iframe.src = path;
  document.body.appendChild(iframe);

  window.setTimeout(() => {
    iframe.remove();
    void caches.open(CACHE_NAME).then((c) => c.delete(path));
  }, EVICT_DELAY_MS);

  return true;
}

/** Strip path separators, quotes and CR/LF (header-injection + bad names); keep hyphens. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\/]+/g, "_").trim() || "tour.gpx";
}
