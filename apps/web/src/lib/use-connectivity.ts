// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

// `/api/health` is @Public() + NetworkOnly in the service worker, so a resolved
// fetch means the server was genuinely reached and a reject/timeout means we're
// offline. This is authoritative — unlike `navigator.onLine` (which reports
// "online" with a network interface but no connectivity) and unlike inferring
// from map tile loads (a cached tile looks identical to being online).
const PROBE_URL = "/api/health";
const PROBE_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * - `online`  — reached the origin (a real 2xx/non-auth HTTP response).
 * - `offline` — no network: the fetch threw or `navigator.onLine` is false.
 * - `auth`    — an edge auth gate (Cloudflare Access) intercepted the probe with
 *   a cross-origin login redirect. We're NOT offline; the session just lapsed.
 */
export type Connectivity = "online" | "offline" | "auth";

/**
 * Classify a probe outcome. Pure + exported for testing. An expired Cloudflare
 * Access session answers a fetch with a 302 to a cross-origin login page; with
 * `redirect: "manual"` the browser surfaces that as an opaque redirect
 * (`type: "opaqueredirect"`, `status: 0`) instead of throwing a CORS error — so
 * "needs to re-auth at the edge" is distinguishable from "truly offline". Some
 * Access configs answer XHR/fetch with 401/403 instead; treat those as auth too.
 */
export function classifyProbe(
  res: Pick<Response, "type" | "status">,
): Connectivity {
  if (res.type === "opaqueredirect") return "auth";
  if (res.status === 401 || res.status === 403) return "auth";
  return res.status > 0 ? "online" : "offline";
}

async function probe(): Promise<Connectivity> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return "offline";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(PROBE_URL, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return classifyProbe(res);
  } catch {
    return "offline";
  }
}

/**
 * Authoritative connectivity, decoupled from map-tile rendering. Probes
 * `/api/health` on mount, on the browser online/offline events, on tab
 * re-focus, periodically, and on demand via the returned `recheck` (the map
 * calls it the moment basemap tiles fail, so a flaky/cellular drop — where no
 * `offline` event fires — is caught immediately instead of after the interval).
 */
export function useConnectivity(): {
  status: Connectivity;
  online: boolean;
  recheck: () => void;
} {
  const [status, setStatus] = useState<Connectivity>(() =>
    typeof navigator === "undefined" || navigator.onLine ? "online" : "offline",
  );
  const inFlight = useRef(false);
  const recheckRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      const next = await probe();
      inFlight.current = false;
      if (!cancelled) setStatus(next);
    };
    recheckRef.current = () => void check();

    void check();
    const onOnline = (): void => void check();
    const onOffline = (): void => {
      if (!cancelled) setStatus("offline");
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(() => void check(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, []);

  return {
    status,
    online: status === "online",
    recheck: () => recheckRef.current(),
  };
}
