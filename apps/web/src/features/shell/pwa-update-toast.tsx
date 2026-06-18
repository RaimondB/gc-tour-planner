// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type JSX } from "react";

/**
 * Pure presentational "update available" toast. Split out from
 * {@link PwaUpdatePrompt} (which owns the service-worker lifecycle via the
 * `virtual:pwa-register/react` hook) so the layout can be rendered in isolation
 * — both by the dev visual harness (`dev/pwa-preview.html`) and any test —
 * without pulling in the SW machinery. On mobile this collapses to a full-width
 * bottom bar (see `.pwa-update-toast` in styles.css).
 */
export function UpdateToast({
  onReload,
  onDismiss,
}: {
  onReload: () => void;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="pwa-update-toast" role="status" aria-live="polite">
      <span>Update available.</span>
      <div className="pwa-update-toast__actions">
        <button
          type="button"
          className="pwa-update-toast__reload"
          onClick={onReload}
        >
          Reload
        </button>
        <button
          type="button"
          className="pwa-update-toast__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss update notice"
        >
          Later
        </button>
      </div>
    </div>
  );
}
