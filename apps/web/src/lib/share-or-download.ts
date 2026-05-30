// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Web Share API → fallback to download. Hands a single file to the
 * native share sheet on phones (iOS Safari, Chrome Android), which lets
 * the user pick the destination app — Garmin Connect, Drive, Mail,
 * AirDrop, etc. — without first saving + re-uploading.
 *
 * Falls back to a classic anchor-click download when:
 *   * The browser has no `navigator.share` (older desktop browsers).
 *   * `navigator.canShare({ files })` returns false for this file type
 *     (Firefox Android, older Safari, most desktops).
 *   * The share attempt throws something other than `AbortError`.
 *
 * AbortError (user dismissed the share sheet) is treated as an
 * intentional cancel — we do NOT fall back to download in that case,
 * since the user already saw the action and chose not to share.
 */
export async function shareOrDownload(opts: {
  text: string;
  filename: string;
  mimeType: string;
  /** Optional `title` + `text` for the share sheet's metadata. */
  shareTitle?: string;
  shareText?: string;
}): Promise<void> {
  const { text, filename, mimeType, shareTitle, shareText } = opts;
  const blob = new Blob([text], { type: mimeType });
  if (canShareFiles({ filename, mimeType })) {
    const file = new File([blob], filename, { type: mimeType });
    try {
      await navigator.share({
        files: [file],
        ...(shareTitle ? { title: shareTitle } : {}),
        ...(shareText ? { text: shareText } : {}),
      });
      return;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // Fall through to download on permission / unknown errors.
      console.warn("[share] failed, falling back to download:", err);
    }
  }
  downloadBlob(blob, filename);
}

/**
 * Synchronous feature detection — call once at component mount to
 * decide button labelling. Allocates a tiny dummy file because some
 * browsers' `canShare` checks the actual file shape, not just the
 * presence of a `files` property.
 */
export function canShareFiles({
  filename,
  mimeType,
}: {
  filename: string;
  mimeType: string;
}): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return false;
  try {
    const probe = new File([""], filename, { type: mimeType });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
