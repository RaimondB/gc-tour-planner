// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

const PREFIX = "gctp:";

/**
 * `useState` that also persists the value to `localStorage`. On mount we
 * read the stored value (if any) and use it as the initial state; on
 * every change we write back. Resilient to:
 *
 *   * `localStorage` being unavailable (private-mode quirks, quota
 *     exceeded) — falls back to in-memory state without crashing.
 *   * Invalid JSON or shape drift — returns the supplied `initial`.
 *   * **Object-shape evolution**: when `initial` is a plain object,
 *     the stored snapshot is shallow-merged on top of `initial`, so
 *     fields added in a later release fall back to their defaults
 *     instead of being undefined.
 *
 * Not appropriate for sensitive data or large payloads (the 5 MB
 * per-origin localStorage cap and the synchronous write on every change
 * matter for big arrays).
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const fullKey = PREFIX + key;
  const [v, setV] = useState<T>(() => loadOrDefault(fullKey, initial));
  // Track the last write to avoid round-tripping the initial value back
  // through localStorage on the first render (the read already set it).
  const lastWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      const json = JSON.stringify(v);
      if (json !== lastWrittenRef.current) {
        localStorage.setItem(fullKey, json);
        lastWrittenRef.current = json;
      }
    } catch {
      // Quota exceeded or storage disabled — best effort; state stays
      // in-memory for this session.
    }
  }, [fullKey, v]);
  return [v, setV];
}

function loadOrDefault<T>(fullKey: string, initial: T): T {
  try {
    const raw = localStorage.getItem(fullKey);
    if (raw === null) return initial;
    const parsed = JSON.parse(raw);
    // Shallow-merge for object-shape resilience. Arrays / primitives
    // pass through as-is.
    if (
      typeof initial === "object" &&
      initial !== null &&
      !Array.isArray(initial) &&
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return { ...initial, ...parsed } as T;
    }
    return parsed as T;
  } catch {
    return initial;
  }
}
