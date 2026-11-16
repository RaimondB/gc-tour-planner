// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { haversineMeters } from "@gctp/shared/geo";

export interface FollowState {
  /** Index of the next stop to head for, or -1 when all stops are done. */
  targetIndex: number;
  /** Indices reached so far (input set ∪ any stop now within `arriveM`). */
  visited: ReadonlySet<number>;
}

/**
 * Advance "follow this tour" state from the user's live position (ADR-location).
 * Marks every not-yet-visited stop the user is currently within `arriveM` metres
 * of as reached (you can walk past several at once), then targets the first stop
 * still unvisited in plan order. Pure — the live wiring lives in the planner.
 */
export function advanceFollow(
  stops: readonly (readonly [number, number])[],
  position: readonly [number, number],
  visited: ReadonlySet<number>,
  arriveM = 30,
): FollowState {
  const next = new Set(visited);
  for (let i = 0; i < stops.length; i += 1) {
    if (!next.has(i) && haversineMeters(position, stops[i]!) <= arriveM) {
      next.add(i);
    }
  }
  let targetIndex = -1;
  for (let i = 0; i < stops.length; i += 1) {
    if (!next.has(i)) {
      targetIndex = i;
      break;
    }
  }
  return { targetIndex, visited: next };
}
