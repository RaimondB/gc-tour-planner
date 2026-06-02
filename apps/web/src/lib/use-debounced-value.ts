// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delayMs` of
 * quiet. Used to throttle the caches query inputs so dragging the radius
 * slider (or rapid filter changes) fires one `/caches` request after the user
 * settles instead of one per tick. Pair with React Query's AbortSignal so any
 * request that *is* superseded gets cancelled rather than left in flight.
 *
 * `value` should be a referentially-stable object (e.g. a `useMemo` result):
 * the effect re-arms on every change of the reference.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
