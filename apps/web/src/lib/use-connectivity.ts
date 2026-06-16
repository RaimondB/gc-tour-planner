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

async function probe(): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(PROBE_URL, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.status > 0; // any real HTTP response means we reached the server
  } catch {
    return false;
  }
}

/**
 * Authoritative connectivity, decoupled from map-tile rendering. Probes
 * `/api/health` on mount, on the browser online/offline events, on tab
 * re-focus, periodically, and on demand via the returned `recheck` (the map
 * calls it the moment basemap tiles fail, so a flaky/cellular drop — where no
 * `offline` event fires — is caught immediately instead of after the interval).
 */
export function useConnectivity(): { online: boolean; recheck: () => void } {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const inFlight = useRef(false);
  const recheckRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      const ok = await probe();
      inFlight.current = false;
      if (!cancelled) setOnline(ok);
    };
    recheckRef.current = () => void check();

    void check();
    const onOnline = (): void => void check();
    const onOffline = (): void => {
      if (!cancelled) setOnline(false);
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

  return { online, recheck: () => recheckRef.current() };
}
