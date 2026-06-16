// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState, type JSX } from "react";

/**
 * The `beforeinstallprompt` event — not in the standard DOM lib types. The
 * browser fires it when the PWA install criteria are met; we stash it and
 * surface our own button rather than relying on a browser menu entry.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * In-app "Install" affordance (FR-W1). Modern browsers no longer pop an
 * automatic install banner — `beforeinstallprompt` only becomes a visible
 * dialog if the app catches it and calls `prompt()`. We show a small toast
 * with an Install button when the app is installable and not already running
 * standalone. iOS Safari never fires this event (install is Share → Add to
 * Home Screen there), so the toast simply never appears on iOS.
 */
export function PwaInstallPrompt(): JSX.Element | null {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const onBeforeInstall = (e: Event): void => {
      // Suppress the legacy mini-infobar; we drive the prompt from our button.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => setDeferred(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred) return null;

  const install = async (): Promise<void> => {
    await deferred.prompt();
    await deferred.userChoice;
    // The event is single-use; drop it whatever the user chose.
    setDeferred(null);
  };

  return (
    <div className="pwa-install-toast" role="dialog" aria-label="Install app">
      <span>Install the app for a home-screen icon and offline tours.</span>
      <div className="pwa-install-toast__actions">
        <button
          type="button"
          className="pwa-install-toast__install"
          onClick={() => void install()}
        >
          Install
        </button>
        <button
          type="button"
          className="pwa-install-toast__dismiss"
          onClick={() => setDeferred(null)}
          aria-label="Dismiss install prompt"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
