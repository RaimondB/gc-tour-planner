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
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
