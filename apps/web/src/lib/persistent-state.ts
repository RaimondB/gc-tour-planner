// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { GeoJsonLineString } from "@gctp/shared/geo";
import type { PlanResult } from "@gctp/shared/tours";

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

/**
 * Stable 8-char hex signature for a planned tour. Used to key
 * `localStorage` entries that hold the user's manual leg-route edits
 * — when a new plan with a different signature arrives we want
 * yesterday's edits left alone in storage, not silently re-applied to
 * a different cluster.
 *
 * Inputs: the visit-order cache ids + the parking coordinates rounded
 * to 5 decimal places (~1 m). Identical math to the planner's
 * `stableClusterId` so signatures match what the planner could in
 * future ship server-side. FNV-1a 32-bit.
 */
export function planSignature(result: PlanResult): string {
  let h = 0x811c9dc5;
  const eat = (v: number): void => {
    let x = v | 0;
    for (let b = 0; b < 4; b += 1) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193);
      x >>>= 8;
    }
  };
  for (const id of result.orderedCacheIds) eat(id);
  // Round parking to 5 decimals (~1 m) so floating-point noise doesn't
  // bust the signature for an otherwise-identical plan.
  const [lng, lat] = result.parking.point.coordinates;
  eat(Math.round((lng ?? 0) * 1e5));
  eat(Math.round((lat ?? 0) * 1e5));
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── Per-leg pick (FR-T11) ────────────────────────────────────────────
//
// Two kinds of edit are persisted per leg:
//
//   * `alt`  — user picked one of the OSRM alternatives the loop-aware
//              picker already considered (no extra OSRM cost).
//   * `via`  — user dragged a via-waypoint on the map; we store the
//              final via coord + the OSRM `from → via → to` geometry.
//              The geometry is persisted so reloading restores the line
//              without re-hitting OSRM; the via coord is kept so the
//              user can re-grab and refine the marker.
//
// The union is open: legPicks for an arbitrary localStorage entry may
// also contain an `undefined` slot. Resolve via `resolvePick` so call
// sites stay tidy and never have to repeat the fallback dance.

export interface LegPickAlt {
  kind: "alt";
  altIndex: number;
}

export interface LegPickVia {
  kind: "via";
  via: [number, number];
  meters: number;
  seconds: number;
  geometry: GeoJsonLineString;
}

export type LegPick = LegPickAlt | LegPickVia;

export type LegPicks = Record<number, LegPick>;

/**
 * Resolve a per-leg pick into the actual geometry + meters/seconds the
 * UI should render and aggregate. Defensive against:
 *  - missing pick (no edit applied → planner's selected alternative)
 *  - legacy stored values (a bare number from the pre-via shape →
 *    treated as an `alt` pick)
 *  - out-of-range `altIndex` (falls back to the first alternative)
 *  - solver-path legs with `alternatives: []` (returns the planner's
 *    chosen meters/seconds from the leg envelope).
 */
export function resolvePick(
  leg: {
    meters: number;
    seconds: number;
    geometry: GeoJsonLineString;
    alternatives: readonly { meters: number; seconds: number; geometry: GeoJsonLineString }[];
    selectedAlternativeIndex: number;
  },
  pick: LegPick | number | undefined,
): { meters: number; seconds: number; geometry: GeoJsonLineString } {
  if (pick && typeof pick === "object" && pick.kind === "via") {
    return { meters: pick.meters, seconds: pick.seconds, geometry: pick.geometry };
  }
  const idx =
    pick && typeof pick === "object" && pick.kind === "alt"
      ? pick.altIndex
      : typeof pick === "number"
        ? pick
        : leg.selectedAlternativeIndex;
  const alt = leg.alternatives[idx] ?? leg.alternatives[0];
  if (alt) return { meters: alt.meters, seconds: alt.seconds, geometry: alt.geometry };
  // Solver path — no alternatives surfaced. Use the leg envelope's own
  // meters/seconds/geometry, which `PlanResult.legs` carries verbatim
  // for the chosen pick.
  return { meters: leg.meters, seconds: leg.seconds, geometry: leg.geometry };
}
