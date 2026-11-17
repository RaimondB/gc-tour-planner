// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  metersBetween,
  type LngLat,
  type WalkSession,
} from "./walk-session.js";

/**
 * The on-device deadline guard (FR-T18): works with or without a fresh server
 * plan, so it keeps protecting the return time offline. Without a plan it uses
 * the straight-line distance home × a walking detour factor at the profile's
 * pace — never the calibrated (possibly faster) pace.
 */

/** Straight line → walking route, a conservative rule of thumb. */
export const DETOUR_FACTOR = 1.3;
/** Under this many minutes before you'd have to head straight home: "tight". */
export const TIGHT_MINUTES = 15;
/** A plan older than this no longer speaks for the return time. */
export const PLAN_FRESH_MS = 10 * 60_000;

export type GuardStatus = "ok" | "tight" | "head-back" | "late";

export interface GuardState {
  status: GuardStatus;
  /** Latest time to set off home and still make deadline − buffer. */
  leaveBy: Date;
  slackMinutes: number;
  /** Walking straight home from here, estimated on-device. */
  minutesHome: number;
  /** True when the numbers come from the server plan (fresh, feasible). */
  fromPlan: boolean;
}

export function minutesHomeEstimate(
  position: LngLat,
  returnPoint: LngLat,
  walkingKmh: number,
): number {
  const meters = metersBetween(position, returnPoint) * DETOUR_FACTOR;
  return meters / ((walkingKmh * 1000) / 60);
}

export function deadlineGuard(
  s: WalkSession,
  now: Date,
  position: LngLat | null,
): GuardState {
  const target =
    Date.parse(s.deadline) - s.profile.budget.bufferMinutes * 60_000;
  const minutesHome = position
    ? minutesHomeEstimate(position, s.returnPoint, s.profile.time.walkingKmh)
    : (s.plan?.minutesToReturn ?? 0);
  const fresh =
    s.plan !== null &&
    s.plannedAt !== null &&
    now.getTime() - Date.parse(s.plannedAt) <= PLAN_FRESH_MS;

  if (now.getTime() > Date.parse(s.deadline)) {
    return {
      status: "late",
      leaveBy: new Date(target - minutesHome * 60_000),
      slackMinutes: (target - now.getTime()) / 60_000 - minutesHome,
      minutesHome,
      fromPlan: false,
    };
  }

  // A fresh, feasible plan knows the real route home and the stops ahead.
  if (fresh && s.plan!.feasible) {
    const slack =
      s.plan!.slackMinutes -
      (now.getTime() - Date.parse(s.plannedAt!)) / 60_000;
    const leaveBy = new Date(s.plan!.leaveLastBy);
    // The plan fills the time on purpose, so its own spare minutes are usually
    // small. Status is about the risk of not making it back: walking straight
    // home from here.
    const homeNow = (target - now.getTime()) / 60_000 - minutesHome;
    return {
      status: statusFor(homeNow),
      leaveBy,
      slackMinutes: Math.min(slack, homeNow),
      minutesHome,
      fromPlan: true,
    };
  }

  const slack = (target - now.getTime()) / 60_000 - minutesHome;
  return {
    status: statusFor(slack),
    leaveBy: new Date(target - minutesHome * 60_000),
    slackMinutes: slack,
    minutesHome,
    fromPlan: false,
  };
}

/** By how many minutes walking straight home still beats deadline − buffer. */
function statusFor(homeSlack: number): GuardStatus {
  if (homeSlack <= 0) return "head-back";
  if (homeSlack < TIGHT_MINUTES) return "tight";
  return "ok";
}
