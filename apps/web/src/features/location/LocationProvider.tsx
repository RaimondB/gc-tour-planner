// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useLocalStorageState } from "../../lib/persistent-state.js";

export type LocationStatus =
  | "off" // not enabled
  | "locating" // enabled, no fix yet
  | "watching" // enabled, have a fix
  | "denied" // permission refused
  | "unavailable"; // no geolocation API / hardware

interface LocationValue {
  /** Current `[lng, lat]`, or null when off / no fix yet. */
  position: [number, number] | null;
  /** Accuracy radius in metres of the last fix, or null. */
  accuracyM: number | null;
  status: LocationStatus;
  /** User opted in (persisted) — the live watch may still be paused (tab hidden). */
  enabled: boolean;
  enable: () => void;
  disable: () => void;
}

const LocationContext = createContext<LocationValue | null>(null);

/**
 * App-wide current-location state (above the router, so the planner map AND the
 * My Tours list both read it). **Opt-in and privacy-preserving**: a live GPS
 * `watchPosition` runs only while the user has enabled it, the position lives
 * only in memory (only the *enabled* preference is persisted), and it is **never
 * sent to the server** — all distance/sort/follow math is client-side.
 *
 * Battery-aware: the watch is torn down while the tab is hidden and resumed on
 * return. Decoupled from connectivity — geolocation works offline.
 */
export function LocationProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [enabled, setEnabled] = useLocalStorageState<boolean>(
    "location-enabled",
    false,
  );
  const [position, setPosition] = useState<[number, number] | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [status, setStatus] = useState<LocationStatus>("off");
  // Distinguish "tab hidden" pause from "off" without re-rendering on every flip.
  const hiddenRef = useRef(false);

  const enable = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }
    setEnabled(true);
    setStatus((s) => (s === "watching" ? s : "locating"));
  }, [setEnabled]);

  const disable = useCallback(() => {
    setEnabled(false);
    setPosition(null);
    setAccuracyM(null);
    setStatus("off");
  }, [setEnabled]);

  // The live watch. Runs only when enabled and the tab is visible; re-created on
  // visibility change so a hidden tab doesn't keep the GPS warm.
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }

    let watchId: number | null = null;

    const start = () => {
      if (watchId !== null) return;
      setStatus((s) => (s === "watching" ? s : "locating"));
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setPosition([pos.coords.longitude, pos.coords.latitude]);
          setAccuracyM(pos.coords.accuracy);
          setStatus("watching");
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            setStatus("denied");
            setEnabled(false); // don't nag the permission prompt every mount
          }
          // POSITION_UNAVAILABLE / TIMEOUT: keep watching, the next fix may land.
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
      );
    };

    const stop = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    };

    const onVisibility = () => {
      hiddenRef.current = document.hidden;
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [enabled, setEnabled]);

  const value = useMemo<LocationValue>(
    () => ({ position, accuracyM, status, enabled, enable, disable }),
    [position, accuracyM, status, enabled, enable, disable],
  );

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation(): LocationValue {
  const ctx = useContext(LocationContext);
  if (!ctx) {
    throw new Error("useLocation must be used within a LocationProvider");
  }
  return ctx;
}
