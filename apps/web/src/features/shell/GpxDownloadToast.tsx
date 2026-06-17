// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type JSX, useEffect, useState } from "react";

import { onGpxSaved } from "../../lib/gpx-saved-events.js";

/** Auto-dismiss after this long if the user doesn't act. */
const VISIBLE_MS = 12_000;

/**
 * Confirmation toast shown after a service-worker GPX save. The installed PWA
 * has no browser download shelf and Edge surfaces the OS download notification
 * only in the shade, so this is the immediate, in-app feedback that the file
 * was written — naming it (see lib/tour-filename.ts) so it's recognisable.
 *
 * It is intentionally a *pure confirmation*: there is no web API that can open
 * the OS Downloads UI or the "open with" chooser for a `.gpx` from Edge's
 * standalone PWA (the Android intent is sandboxed away, and Web Share rejects
 * `.gpx`). The user opens the file from the shade notification or a file
 * manager — both of which do fire the OS "open with" dialog. [ADR-0032]
 */
export function GpxDownloadToast(): JSX.Element | null {
  const [filename, setFilename] = useState<string | null>(null);

  useEffect(() => onGpxSaved((name) => setFilename(name)), []);

  useEffect(() => {
    if (filename === null) return;
    const t = window.setTimeout(() => setFilename(null), VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, [filename]);

  if (filename === null) return null;

  return (
    <div className="gpx-saved-toast" role="status" aria-live="polite">
      <span className="gpx-saved-toast__msg">
        Saved <strong>{filename}</strong> to your downloads.
      </span>
      <button
        type="button"
        className="gpx-saved-toast__dismiss"
        onClick={() => setFilename(null)}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
