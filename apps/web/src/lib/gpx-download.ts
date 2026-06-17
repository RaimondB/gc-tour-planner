// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { downloadText } from "./download-text.js";
import { emitGpxSaved } from "./gpx-saved-events.js";
import { swDownload } from "./sw-download.js";

export interface DownloadGpxOpts {
  text: string;
  filename: string;
  mimeType: string;
}

/**
 * Save a GPX file to the device. We do NOT use the Web Share API: Chromium's
 * Web Share allowlist rejects `.gpx`/`application/gpx+xml` (both extension and
 * MIME must be permitted), so a real `.gpx` can never go through the share
 * sheet anyway.
 *
 * Two tiers:
 *  1. The service-worker download (lib/sw-download.ts) — the only path that
 *     reliably surfaces a real, openable download inside Android "installed"
 *     PWAs (where in-page anchor/blob `download` is silently swallowed), and it
 *     works offline. Used whenever a SW is controlling the page.
 *  2. The anchor download (lib/download-text.ts) — the fallback for the first
 *     load before the SW activates, browsers without SW/Cache support, and dev.
 *
 * On the SW path we fire `emitGpxSaved` so the in-app toast confirms the save
 * (naming the file) — the installed PWA has no download shelf of its own. The
 * anchor fallback needs no toast (the browser shows its own download shelf).
 */
export async function downloadGpx(opts: DownloadGpxOpts): Promise<void> {
  if (await swDownload(opts)) {
    emitGpxSaved(opts.filename);
    return;
  }
  downloadText(opts);
}
