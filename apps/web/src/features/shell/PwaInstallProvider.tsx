// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

/**
 * The `beforeinstallprompt` event — not in the standard DOM lib types. The
 * browser fires it when the PWA install criteria are met; we stash it so the
 * app can drive its own install affordance rather than relying on a browser
 * menu entry. iOS Safari never fires it (install is Share → Add to Home Screen).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaInstallContextValue {
  /** True once the browser has offered installation and the app isn't already standalone. */
  canInstall: boolean;
  /** Fires the native install prompt. No-op (resolves immediately) when not installable. */
  promptInstall: () => Promise<void>;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

/**
 * Captures `beforeinstallprompt` once, above the router, and exposes install
 * state to the whole app (FR-W1, [ADR-0028]). Surfacing install as a hamburger
 * menu item — rather than an intrusive toast — keeps the affordance discoverable
 * without covering the map. The event is single-use, so we drop it after a
 * prompt and on `appinstalled`; `canInstall` then goes false and the menu item
 * disappears.
 */
export function PwaInstallProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const onBeforeInstall = (e: Event): void => {
      // Suppress the legacy mini-infobar; we drive the prompt from our own UI.
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

  const value = useMemo<PwaInstallContextValue>(
    () => ({
      canInstall: deferred !== null,
      promptInstall: async (): Promise<void> => {
        if (!deferred) return;
        await deferred.prompt();
        await deferred.userChoice;
        // The event is single-use; drop it whatever the user chose.
        setDeferred(null);
      },
    }),
    [deferred],
  );

  return (
    <PwaInstallContext.Provider value={value}>
      {children}
    </PwaInstallContext.Provider>
  );
}

/**
 * Read install state. Outside a provider (e.g. an isolated render) it degrades
 * to "not installable" so the calling component simply omits the affordance.
 */
export function usePwaInstall(): PwaInstallContextValue {
  return (
    useContext(PwaInstallContext) ?? {
      canInstall: false,
      promptInstall: async () => {},
    }
  );
}
