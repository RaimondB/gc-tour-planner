// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { WalkCalibration } from "@gctp/shared/walks";
import { metersBetween, type WalkSession } from "./walk-session.js";

/**
 * Live calibration (FR-T18, ADR-0040 §4): how fast the walker really walks and
 * how long they really spend at a cache, compared with the profile. The server
 * clamps both and never uses a faster pace for the walk home.
 */

/** Track segments outside this speed band aren't walking (standing / GPS jump). */
const MIN_WALK_MPS = 0.4;
const MAX_WALK_MPS = 2.5;
/** Need this much measured walking before trusting the pace. */
const MIN_WALKED_M = 300;

export function calibrate(s: WalkSession): WalkCalibration {
  return { paceFactor: paceFactor(s), dwellFactor: dwellFactor(s) };
}

export function paceFactor(s: WalkSession): number {
  let meters = 0;
  let seconds = 0;
  for (let i = 1; i < s.track.length; i += 1) {
    const a = s.track[i - 1]!;
    const b = s.track[i]!;
    const dt = (b[2] - a[2]) / 1000;
    if (dt <= 0) continue;
    const d = metersBetween(a, b);
    const v = d / dt;
    if (v < MIN_WALK_MPS || v > MAX_WALK_MPS) continue;
    meters += d;
    seconds += dt;
  }
  if (meters < MIN_WALKED_M || seconds <= 0) return 1;
  const profileMps = s.profile.time.walkingKmh / 3.6;
  return meters / seconds / profileMps;
}

/**
 * Observed ÷ planned time at caches, over the visits we saw start (auto-arrive)
 * and that a plan had a visit time for.
 */
export function dwellFactor(s: WalkSession): number {
  let observed = 0;
  let planned = 0;
  for (const entry of s.log) {
    if (!entry.arrivedAt || entry.outcome === "skipped") continue;
    const plan = s.plannedVisitMs[entry.cacheId];
    const real = Date.parse(entry.at) - Date.parse(entry.arrivedAt);
    if (!plan || plan <= 0 || real <= 0) continue;
    observed += real;
    planned += plan;
  }
  return planned > 0 ? observed / planned : 1;
}
