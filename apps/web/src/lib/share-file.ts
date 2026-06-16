// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { downloadText } from "./download-text.js";

export interface ShareGpxOpts {
  text: string;
  filename: string;
  mimeType: string;
  /** Short caption for the OS share sheet (e.g. the tour name). */
  title?: string;
}

/**
 * Offer the native share sheet for a GPX file, falling back to the anchor
 * download. We feature-detect with `navigator.canShare({ files })` and only
 * share when the platform accepts the file — `.gpx` is frequently rejected by
 * Chrome's Web Share allowlist (see download-text.ts), so the download stays
 * the guaranteed path and we degrade to it on any unsupported or failed case.
 *
 * A user dismissing the sheet (AbortError) is respected — we do NOT then
 * download, since they had the file in hand and chose to back out. Any other
 * failure falls through to the download.
 */
export async function shareOrDownloadGpx(opts: ShareGpxOpts): Promise<void> {
  const { text, filename, mimeType, title } = opts;

  const file =
    typeof File !== "undefined"
      ? new File([text], filename, { type: mimeType })
      : null;

  const canShareFiles =
    file !== null &&
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    typeof navigator.share === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFiles) {
    try {
      await navigator.share({
        files: [file],
        ...(title ? { title } : {}),
      });
      return;
    } catch (err) {
      // User dismissed the share sheet — respect it, don't force a download.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Anything else (target refused the file, transient error) → download.
    }
  }

  downloadText({ text, filename, mimeType });
}
