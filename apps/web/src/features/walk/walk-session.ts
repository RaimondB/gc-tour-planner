// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { WalkCalibration, WalkReplanResult } from "@gctp/shared/walks";
import { haversineMeters } from "@gctp/shared/geo";

/**
 * The ad-hoc walk as the client holds it (FR-T18, ADR-0040). The server is
 * stateless, so this record IS the walk: persisted on every intent (IndexedDB)
 * and sent whole with each replan. Pure reducer — the provider owns I/O.
 */

export type LngLat = [number, number];
export type Outcome = "found" | "dnf" | "skipped";

export interface WalkSession {
  id: string;
  startedAt: string;
  profileId: string | null;
  profileName: string;
  /** Snapshot: the walk keeps its settings even if the profile is edited. */
  profile: RouteProfileSettings;
  /** Back at the return point by this time (ISO). */
  deadline: string;
  /**
   * Set when the walk was given a duration (not a back-by time): until the
   * start point is reached, the deadline slides — getting there doesn't eat
   * the walk's time.
   */
  durationMinutes: number | null;
  returnPoint: LngLat;
  /** Where the walk starts (a map point, or where the user was). */
  startPoint: LngLat;
  /**
   * True until the walker reaches the start point. Plans then start at
   * `startPoint`, not at the live position, and nothing is tracked yet.
   */
  pendingStart: boolean;
  /** Visits in the order they happened. */
  log: {
    cacheId: number;
    outcome: Outcome;
    arrivedAt: string | null;
    at: string;
  }[];
  /** The cache the walker is standing at (auto-arrive), until they log it. */
  atCache: { cacheId: number; since: string } | null;
  /** "Go here next" — always first until visited or cleared. */
  lockedNextId: number | null;
  /** The latest server plan, and when / from where it was made. */
  plan: WalkReplanResult | null;
  plannedAt: string | null;
  /**
   * Planned minutes-at-the-cache (ms) by cache id, remembered from every plan
   * — a stop leaves the plan once logged, but calibration still needs it.
   */
  plannedVisitMs: Record<number, number>;
  /** Stop details seen in any plan — names and places for the log and saving. */
  knownStops: Record<number, KnownStop>;
  calibration: WalkCalibration;
  /** Found marks made offline, sent when back online. */
  pendingFinds: number[];
  /** Thinned GPS track [lng, lat, epoch ms] — pace calibration + saved route. */
  track: [number, number, number][];
}

export type KnownStop = Pick<
  WalkReplanResult["order"][number],
  "code" | "name" | "type" | "location"
>;

export type WalkAction =
  | { type: "arrived"; cacheId: number; at: string }
  | { type: "logged"; cacheId: number; outcome: Outcome; at: string }
  | { type: "locked"; cacheId: number | null }
  | { type: "planned"; plan: WalkReplanResult; at: string }
  | { type: "calibrated"; calibration: WalkCalibration }
  | { type: "tracked"; point: [number, number, number] }
  | { type: "findsFlushed"; cacheIds: readonly number[] }
  | { type: "started"; at: string };

/** Thin the track: keep a point only every ~20 m, cap the length. */
const TRACK_MIN_STEP_M = 20;
const TRACK_MAX_POINTS = 2_000;

export function walkReducer(s: WalkSession, a: WalkAction): WalkSession {
  switch (a.type) {
    case "arrived":
      if (s.atCache?.cacheId === a.cacheId || isLogged(s, a.cacheId)) return s;
      return { ...s, atCache: { cacheId: a.cacheId, since: a.at } };
    case "logged": {
      if (isLogged(s, a.cacheId)) return s;
      const arrivedAt =
        s.atCache?.cacheId === a.cacheId ? s.atCache.since : null;
      return {
        ...s,
        log: [
          ...s.log,
          { cacheId: a.cacheId, outcome: a.outcome, arrivedAt, at: a.at },
        ],
        atCache: s.atCache?.cacheId === a.cacheId ? null : s.atCache,
        lockedNextId: s.lockedNextId === a.cacheId ? null : s.lockedNextId,
        pendingFinds:
          a.outcome === "found"
            ? [...s.pendingFinds, a.cacheId]
            : s.pendingFinds,
      };
    }
    case "locked":
      return { ...s, lockedNextId: a.cacheId };
    case "planned": {
      const plannedVisitMs = { ...s.plannedVisitMs };
      const knownStops = { ...s.knownStops };
      for (const o of a.plan.order) {
        plannedVisitMs[o.cacheId] =
          Date.parse(o.leaveAt) - Date.parse(o.arriveAt);
        knownStops[o.cacheId] = {
          code: o.code,
          name: o.name,
          type: o.type,
          location: o.location,
        };
      }
      return {
        ...s,
        plan: a.plan,
        plannedAt: a.at,
        plannedVisitMs,
        knownStops,
      };
    }
    case "calibrated":
      return { ...s, calibration: a.calibration };
    case "tracked": {
      const last = s.track.at(-1);
      if (last && metersBetween(last, a.point) < TRACK_MIN_STEP_M) return s;
      const track = [...s.track, a.point];
      return {
        ...s,
        track:
          track.length > TRACK_MAX_POINTS
            ? track.slice(-TRACK_MAX_POINTS)
            : track,
      };
    }
    case "started": {
      if (!s.pendingStart) return s;
      const deadline =
        s.durationMinutes !== null
          ? new Date(
              Date.parse(a.at) + s.durationMinutes * 60_000,
            ).toISOString()
          : s.deadline;
      return { ...s, pendingStart: false, deadline };
    }
    case "findsFlushed": {
      const sent = new Set(a.cacheIds);
      return {
        ...s,
        pendingFinds: s.pendingFinds.filter((id) => !sent.has(id)),
      };
    }
  }
}

export function isLogged(s: WalkSession, cacheId: number): boolean {
  return s.log.some((l) => l.cacheId === cacheId);
}

export function idsWith(s: WalkSession, outcome: Outcome): number[] {
  return s.log.filter((l) => l.outcome === outcome).map((l) => l.cacheId);
}

/** The next stop to walk to: the locked one, else the plan's first unlogged. */
export function nextStopId(s: WalkSession): number | null {
  if (s.lockedNextId !== null) return s.lockedNextId;
  return s.plan?.order.find((o) => !isLogged(s, o.cacheId))?.cacheId ?? null;
}

/** Straight-line metres between two [lng, lat, …] points. */
export function metersBetween(
  a: readonly [number, number, ...unknown[]],
  b: readonly [number, number, ...unknown[]],
): number {
  return haversineMeters([a[0], a[1]], [b[0], b[1]]);
}

/** Within this of the start point counts as having reached it. */
export const START_REACHED_M = 150;

/** The deadline in force at `now` (it slides while the start is pending). */
export function effectiveDeadline(s: WalkSession, now: Date): string {
  return s.pendingStart && s.durationMinutes !== null
    ? new Date(now.getTime() + s.durationMinutes * 60_000).toISOString()
    : s.deadline;
}

/** Where a plan starts from: the start point until reached, then the walker. */
export function planOrigin(
  s: WalkSession,
  position: LngLat | null,
): LngLat | null {
  return s.pendingStart ? s.startPoint : position;
}
