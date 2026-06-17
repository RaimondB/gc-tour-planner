// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Anchor-click download for in-memory text. We do NOT use the Web Share
 * API for GPX: Chrome's WebShare allowlist excludes both `.gpx` and
 * `application/gpx+xml`, and Garmin Connect's Android app registers
 * only ACTION_VIEW (file-open) for `.gpx` — not ACTION_SEND — so a
 * successful share wouldn't surface it in the chooser anyway. The
 * download-then-tap flow is the path Garmin/Komoot/RideWithGPS all use.
 */
export function downloadText(opts: {
  text: string;
  filename: string;
  mimeType: string;
}): void {
  const { text, filename, mimeType } = opts;
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Download initiation is asynchronous. Revoking the object URL (and detaching
  // the anchor) synchronously after click() races the browser's handoff to the
  // OS download manager: in slower contexts the URL dies before the download
  // starts and it silently never appears. This is what breaks GPX export in
  // Edge's Android "installed" PWA (a home-screen shortcut, not a true WebAPK,
  // with a slower handoff than Chrome) — nothing pops up. Defer cleanup well
  // past the handoff window. See chromium #827932 / mozilla #1282407.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, REVOKE_DELAY_MS);
}

/**
 * How long to keep the object URL + anchor alive after click(). Generous on
 * purpose — the blob is small (a GPX tour) so the brief retention is harmless,
 * and a short delay can still lose the race on slow standalone-PWA handoffs.
 */
const REVOKE_DELAY_MS = 60_000;
