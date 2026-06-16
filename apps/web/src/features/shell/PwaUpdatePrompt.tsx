// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type JSX } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * Registers the service worker and surfaces a small "update available" toast
 * when a new deploy is waiting. We use the `prompt` strategy (not autoUpdate)
 * so a new SW never swaps lazily-loaded chunks mid-session — the user reloads
 * on their terms. index.html is served `no-store` (see infra/nginx.conf), so
 * the new SW's precache manifest is picked up promptly on the next visit.
 */
/** How often a running app re-checks for a newer service worker. */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

export function PwaUpdatePrompt(): JSX.Element | null {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    // The browser only checks for a new SW on navigation/load, so a deploy is
    // otherwise invisible until the app is restarted. Poll for an update while
    // running (and whenever the app regains focus) so the toast appears live.
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const check = (): void => void registration.update();
      window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="pwa-update-toast" role="status" aria-live="polite">
      <span>A new version is available.</span>
      <div className="pwa-update-toast__actions">
        <button
          type="button"
          className="pwa-update-toast__reload"
          onClick={() => void updateServiceWorker(true)}
        >
          Reload
        </button>
        <button
          type="button"
          className="pwa-update-toast__dismiss"
          onClick={() => setNeedRefresh(false)}
          aria-label="Dismiss update notice"
        >
          Later
        </button>
      </div>
    </div>
  );
}
