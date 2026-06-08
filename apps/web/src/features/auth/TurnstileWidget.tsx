// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, type JSX } from "react";

/**
 * Cloudflare Turnstile (CAPTCHA) widget for the register form (FR-P5, Gate 1.4).
 * Rendered only when `VITE_TURNSTILE_SITE_KEY` is configured; the matching
 * `TURNSTILE_SECRET` on the server then enforces verification. The Cloudflare
 * script and challenge iframe are served by Cloudflare, not bundled, so no
 * copyrighted/managed asset ships in our GPLv3 build.
 */

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Load the Turnstile script once; resolve when `window.turnstile` is ready. */
let scriptPromise: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const onReady = () => {
      // The script sets window.turnstile synchronously after load.
      if (window.turnstile) resolve();
      else reject(new Error("Turnstile failed to initialise"));
    };
    if (existing) {
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Turnstile script failed to load")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Turnstile script failed to load")),
      { once: true },
    );
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  /** Called with the solved token, or null when it expires / errors out. */
  onToken: (token: string | null) => void;
}

export function TurnstileWidget({
  siteKey,
  onToken,
}: TurnstileWidgetProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-rendering the widget on every change.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;

    void loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        // Surface as "unsolved" so the form's required-token guard blocks submit.
        if (!cancelled) onTokenRef.current(null);
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey]);

  return <div ref={containerRef} className="auth-turnstile" />;
}

/** The configured site key, or null when captcha is disabled for this build. */
export const TURNSTILE_SITE_KEY: string | null =
  import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || null;
