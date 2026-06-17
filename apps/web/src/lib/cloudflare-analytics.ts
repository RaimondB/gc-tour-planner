// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Cloudflare Web Analytics — cookieless, no-PII usage analytics.
 *
 * Gated on the public `VITE_CF_WEB_ANALYTICS_TOKEN` build arg (set in production
 * only), mirroring the Turnstile site-key pattern. When the token is unset
 * (dev/UAT/e2e) everything here no-ops, so those environments emit nothing.
 *
 * The beacon loads from Cloudflare's CDN — a deliberate, documented exception to
 * the otherwise no-CDN posture (ADR-0027). See ADR-0030. Offline the fetch fails
 * silently; the cross-origin script is neither precached nor intercepted by the
 * service worker.
 */

const CF_BEACON_TOKEN =
  import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN?.trim() || null;

/** True when analytics is configured (production). Drives the footer note too. */
export const analyticsEnabled = CF_BEACON_TOKEN !== null;

const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

/**
 * Inject the Cloudflare Web Analytics beacon once. Safe to call repeatedly and
 * a no-op when no token is configured.
 */
export function initCloudflareAnalytics(): void {
  if (!CF_BEACON_TOKEN) return;
  if (document.querySelector("script[data-cf-beacon]")) return;

  const script = document.createElement("script");
  script.defer = true;
  script.src = BEACON_SRC;
  script.setAttribute(
    "data-cf-beacon",
    JSON.stringify({ token: CF_BEACON_TOKEN }),
  );
  document.head.appendChild(script);
}
