// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Web Share API → fallback to download. Hands a single file to the
 * native share sheet on phones (iOS Safari, Chrome Android), which lets
 * the user pick the destination app — Garmin Connect, Drive, Mail,
 * AirDrop, etc. — without first saving + re-uploading.
 *
 * Chrome enforces a MIME allowlist on shared files (`application/pdf`,
 * `text/plain`, `text/csv`, `image/*`, etc.) — `application/gpx+xml` is
 * not on it. We try the caller's preferred MIME first, then fall back
 * through a list of generic permitted types. The filename keeps its
 * `.gpx` extension so receiving apps still recognize the file.
 *
 * Falls back to a classic anchor-click download when no MIME passes
 * `canShare`, when the browser has no `navigator.share`, or when the
 * share attempt throws something other than `AbortError`.
 *
 * AbortError (user dismissed the share sheet) is treated as an
 * intentional cancel — we do NOT fall back to download in that case.
 */
const SHARE_FALLBACK_MIME_TYPES = ["text/xml", "application/xml", "text/plain"] as const;

export async function shareOrDownload(opts: {
  text: string;
  filename: string;
  mimeType: string;
  /** Optional `title` + `text` for the share sheet's metadata. */
  shareTitle?: string;
  shareText?: string;
}): Promise<void> {
  const { text, filename, mimeType, shareTitle, shareText } = opts;
  const downloadBlob_ = new Blob([text], { type: mimeType });
  const shareMime = pickShareMimeType({ filename, mimeType });
  if (shareMime) {
    const file = new File([text], filename, { type: shareMime });
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
  downloadBlob(downloadBlob_, filename);
}

/**
 * Synchronous feature detection — call once at component mount to
 * decide button labelling. Returns true when at least one MIME in the
 * fallback chain passes `canShare`.
 */
export function canShareFiles({
  filename,
  mimeType,
}: {
  filename: string;
  mimeType: string;
}): boolean {
  return pickShareMimeType({ filename, mimeType }) !== null;
}

function pickShareMimeType({
  filename,
  mimeType,
}: {
  filename: string;
  mimeType: string;
}): string | null {
  if (typeof navigator === "undefined") return null;
  if (typeof navigator.share !== "function") return null;
  if (typeof navigator.canShare !== "function") return null;
  for (const candidate of [mimeType, ...SHARE_FALLBACK_MIME_TYPES]) {
    try {
      const probe = new File([""], filename, { type: candidate });
      if (navigator.canShare({ files: [probe] })) return candidate;
    } catch {
      // try next
    }
  }
  return null;
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
